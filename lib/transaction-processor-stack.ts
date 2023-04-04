import * as cdk from "@aws-cdk/core";
import * as s3 from "@aws-cdk/aws-s3";
import * as stepFunctions from "@aws-cdk/aws-stepfunctions";
import * as tasks from "@aws-cdk/aws-stepfunctions-tasks";
import * as lambda from "@aws-cdk/aws-lambda";
import * as events from "@aws-cdk/aws-events";
import * as targets from "@aws-cdk/aws-events-targets";
import * as dynamodb from "@aws-cdk/aws-dynamodb";

/**
 * Prefix for transaction CSV files landing on S3
 */
const transactionProvisionRatio =
  process.env.TRANSACTIONS_PROVISION_RATIO || "0.2";

/**
 * A PoC stack that defines
 * - S3 Bucket to store transactions in CSV file
 * - DynamoDB table to persist processed transactions
 * - Step Function and Lambdas to process the transaction
 * - EventBridge Rule to trigger the Step Function
 */
export class TransactionProcessorStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create the S3 bucket
    const s3Bucket = new s3.Bucket(this, "TransactionProcessorBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      eventBridgeEnabled: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Create the DynamoDB table
    const transactionsTable = new dynamodb.Table(
      this,
      "TransactionProcessorTable",
      {
        partitionKey: {
          name: "id",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // Define common NodeJS bundling options
    const nodeJsLambdaBundling: cdk.BundlingOptions = {
      image: lambda.Runtime.NODEJS_16_X.bundlingImage,
      command: [
        "bash",
        "-c",
        [
          "npm install",
          "npm run package",
          "mv lambda-package.zip /asset-output/lambda-package.zip",
        ].join(" && "),
      ],
      user: "root",
    };

    // Create CSV-parser Lambda function
    const parseCsvFunctionCode = lambda.Code.fromAsset(
      "./lambda/parse-csv-function",
      {
        bundling: nodeJsLambdaBundling,
      }
    );
    const parseCsvFunction = new lambda.Function(
      this,
      "TransactionProcessorParseCsvFunction",
      {
        runtime: lambda.Runtime.NODEJS_16_X,
        handler: "dist/parse-csv-function.handler",
        code: parseCsvFunctionCode,
        environment: {
          DYNAMODB_TABLE_NAME: transactionsTable.tableName,
        },
      }
    );

    // Grant read access to the transactions on the S3 bucket
    s3Bucket.grantRead(parseCsvFunction);

    // Create provision generator Lambda function
    const provisionGeneratorFunctionCode = lambda.Code.fromAsset(
      "./lambda/generate-provision-function",
      {
        bundling: nodeJsLambdaBundling,
      }
    );
    const provisionGeneratorFunction = new lambda.Function(
      this,
      "TransactionProcessorProvisionGeneratorFunction",
      {
        runtime: lambda.Runtime.NODEJS_16_X,
        handler: "dist/generate-provision-function.handler",
        code: provisionGeneratorFunctionCode,
        environment: {
          PROVISION_RATIO: transactionProvisionRatio,
        },
      }
    );

    // Create the CSV-parser function Step Functions task
    const parseCsvTask = new tasks.LambdaInvoke(
      this,
      "TransactionProcessorCsvParseTask",
      {
        lambdaFunction: parseCsvFunction,
        payloadResponseOnly: true,
      }
    );

    // Create the DynamoDB Step Functions persistence tasks
    const persistTransactionTaskItemDefinition: tasks.DynamoPutItemProps["item"] =
      {
        id: tasks.DynamoAttributeValue.fromString(
          stepFunctions.JsonPath.stringAt("$.id")
        ),
        date: tasks.DynamoAttributeValue.fromString(
          stepFunctions.JsonPath.stringAt("$.date")
        ),
        accountId: tasks.DynamoAttributeValue.fromString(
          stepFunctions.JsonPath.stringAt("$.accountId")
        ),
        amount: tasks.DynamoAttributeValue.fromNumber(
          stepFunctions.JsonPath.numberAt("$.amount")
        ),
      };
    const persistTransactionTask = new tasks.DynamoPutItem(
      this,
      "TransactionProcessorPersistTransactionTask",
      {
        item: persistTransactionTaskItemDefinition,
        resultPath: stepFunctions.JsonPath.DISCARD,
        table: transactionsTable,
      }
    );
    const persistTransactionProvisionTask = new tasks.DynamoPutItem(
      this,
      "TransactionProcessorPersistTransactionProvisionTask",
      {
        item: persistTransactionTaskItemDefinition,
        resultPath: stepFunctions.JsonPath.DISCARD,
        table: transactionsTable,
      }
    );

    // Create the step to generate the provision transaction record
    const generateProvisionTask = new tasks.LambdaInvoke(
      this,
      "TransactionProcessorGenerateProvisionTask",
      {
        lambdaFunction: provisionGeneratorFunction,
        payloadResponseOnly: true,
      }
    );

    // Create Step Functions Map state to iterate over parsed CSV transactions
    const processTransactionsMapIterator =
      // don't create and persist transactions if provision ratio == 0
      transactionProvisionRatio === "0"
        ? persistTransactionTask
        : persistTransactionTask
            .next(generateProvisionTask)
            .next(persistTransactionProvisionTask);

    const processTransactionsMap = new stepFunctions.Map(
      this,
      "TransactionProcessorTransactionMap"
    ).iterator(processTransactionsMapIterator);

    // Create the Step Functions transactions processor state machine
    const transactionProcessorStateMachine = new stepFunctions.StateMachine(
      this,
      "TransactionProcessorStateMachine",
      {
        definition: parseCsvTask.next(processTransactionsMap),
      }
    );

    // Create the EventBridge rule to catch new S3 transaction uploads
    const s3EventRule = new events.Rule(this, "TransactionProcessorEventRule", {
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: {
            name: [s3Bucket.bucketName],
          },
          object: {
            key: [{
              suffix: '.csv',
            }],
          },
        },
      },
    });

    // Add the StepFunction state machine as a target for the EventBridge rule
    s3EventRule.addTarget(
      new targets.SfnStateMachine(transactionProcessorStateMachine, {
        input: events.RuleTargetInput.fromObject({
          s3Bucket: s3Bucket.bucketName,
          s3Key: events.EventField.fromPath("$.detail.object.key"),
        }),
      })
    );
  }
}
