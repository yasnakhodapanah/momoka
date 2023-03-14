import { BundlrBulkTxSuccess, getBundlrBulkTxsAPI } from '../bundlr/get-bundlr-bulk-txs.api';
import {
  getDataAvailabilityTransactionsAPI,
  getDataAvailabilityTransactionsAPIResponse,
} from '../bundlr/get-data-availability-transactions.api';
import { checkDAProofWithMetadata } from '../check-da-proof';
import { ClaimableValidatorError } from '../claimable-validator-errors';
import { DAResult } from '../da-result';
import {
  DAPublicationWithTimestampProofsBatchResult,
  DATimestampProofsResponse,
} from '../data-availability-models/data-availability-timestamp-proofs';
import {
  DAEventType,
  DAPublicationsBatchResult,
  DAStructurePublication,
  PublicationTypedData,
} from '../data-availability-models/publications/data-availability-structure-publication';
import {
  FailedTransactionsDb,
  getLastEndCursorDb,
  saveEndCursorDb,
  saveFailedTransactionDb,
  saveTxDAMetadataDb,
  saveTxDb,
  saveTxTimestampProofsMetadataDb,
  startDb,
  TxValidatedResult,
} from '../db';
import { EthereumNode } from '../ethereum';
import { TIMEOUT_ERROR } from '../fetch-with-timeout';
import { base64StringToJson, formatDate, sleep, unixTimestampToMilliseconds } from '../helpers';
import { consoleLog } from '../logger';
// import { watchBlocks } from './block.watcher';
import { verifierFailedSubmissionsWatcher } from './failed-submissons.watcher';
import { StreamCallback } from './stream.type';

let isProcessingFailedSubmission = false;
const processFailedSubmissions = async (
  failedTransaction: FailedTransactionsDb,
  log: (message: string, ...optionalParams: any[]) => void
) => {
  while (isProcessingFailedSubmission) {
    await sleep(10);
  }

  isProcessingFailedSubmission = true;

  await saveFailedTransactionDb(failedTransaction);
  log('process failed submissions saved to db', failedTransaction);

  isProcessingFailedSubmission = false;
};

const buildTxValidationResult = (
  txId: string,
  result: DAResult<
    void | DAStructurePublication<DAEventType, PublicationTypedData>,
    DAStructurePublication<DAEventType, PublicationTypedData>
  >
): TxValidatedResult => {
  if (result.isSuccess()) {
    return { proofTxId: txId, success: true, dataAvailabilityResult: result.successResult! };
  }

  return {
    proofTxId: txId,
    success: false,
    failureReason: result.failure!,
    dataAvailabilityResult: result.context!,
  };
};

const buildDAPublicationsBatchResult = (
  results: BundlrBulkTxSuccess[]
): DAPublicationsBatchResult[] => {
  const daPublications: DAPublicationsBatchResult[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    const daPublication = base64StringToJson(result.data) as DAStructurePublication<
      DAEventType,
      PublicationTypedData
    >;
    saveTxDAMetadataDb(result.id, daPublication);

    daPublications.push({
      id: result.id,
      daPublication,
      submitter: result.address,
    });
  }

  return daPublications;
};

const buildDAPublicationsWithTimestampProofsBatchResult = async (
  results: BundlrBulkTxSuccess[],
  daPublications: DAPublicationsBatchResult[]
): Promise<DAPublicationWithTimestampProofsBatchResult[]> => {
  const daPublicationsWithTimestampProofs: DAPublicationWithTimestampProofsBatchResult[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    const timestampProofsData = base64StringToJson(result.data) as DATimestampProofsResponse;

    saveTxTimestampProofsMetadataDb(result.id, timestampProofsData);

    daPublicationsWithTimestampProofs.push({
      ...daPublications[i],
      submitter: result.address,
      timestampProofsData,
    });
  }

  return daPublicationsWithTimestampProofs;
};

const checkDAProofsBatch = async (
  arweaveTransactions: getDataAvailabilityTransactionsAPIResponse,
  ethereumNode: EthereumNode,
  stream?: StreamCallback
): Promise<void> => {
  const bulkDAProofs = await getBundlrBulkTxsAPI(
    arweaveTransactions.edges.map((edge) => edge.node.id)
  );
  if (bulkDAProofs === TIMEOUT_ERROR) {
    throw new Error('getBundlrBulkTxsAPI for proofs timed out');
  }

  const daPublications = buildDAPublicationsBatchResult(bulkDAProofs.success);

  const bulkDATimestampProofs = await getBundlrBulkTxsAPI(
    daPublications.map((pub) => pub.daPublication.timestampProofs.response.id)
  );
  if (bulkDATimestampProofs === TIMEOUT_ERROR) {
    throw new Error('getBundlrBulkTxsAPI for timestamps timed out');
  }

  const daPublicationsWithTimestampProofs = await buildDAPublicationsWithTimestampProofsBatchResult(
    bulkDATimestampProofs.success,
    daPublications
  );

  await Promise.allSettled(
    daPublicationsWithTimestampProofs.map(async (publication) => {
      const txId = publication.id;
      const log = (message: string, ...optionalParams: any[]) => {
        consoleLog(
          '\x1b[32m',
          `LENS VERIFICATION NODE - tx at - ${formatDate(
            new Date(unixTimestampToMilliseconds(Number(publication.daPublication.event.timestamp)))
          )} - ${txId} - ${message}`,
          ...optionalParams
        );
      };

      try {
        const result = await checkDAProofWithMetadata(txId, publication, ethereumNode, {
          verifyPointer: true,
          log: () => {},
        });

        const txValidatedResult: TxValidatedResult = buildTxValidationResult(txId, result);

        // write to the database!
        saveTxDb(txId, txValidatedResult);

        if (result.isFailure()) {
          // fire and forget
          processFailedSubmissions(
            { txId, reason: result.failure!, submitter: publication.submitter },
            () => {}
          );
        }

        if (stream) {
          log(`stream the DA publication - ${txId}`);
          // stream the result to the callback defined
          stream(txValidatedResult);
        }

        log(`${result.isFailure() ? `FAILED - ${result.failure!}` : 'OK'}`);
      } catch (e: any) {
        saveTxDb(txId, {
          proofTxId: txId,
          success: false,
          failureReason: ClaimableValidatorError.UNKNOWN,
          dataAvailabilityResult: undefined,
          extraErrorInfo: typeof e === 'string' ? e : e.message || undefined,
        });

        // fire and forget
        processFailedSubmissions(
          { txId, reason: ClaimableValidatorError.UNKNOWN, submitter: publication.submitter },
          () => {}
        );

        log(e);
      }
    })
  );
};

export const startDAVerifierNode = async (
  ethereumNode: EthereumNode,
  dbLocationFolderPath: string,
  stream?: StreamCallback | undefined
) => {
  consoleLog('LENS VERIFICATION NODE - DA verification watcher started...');

  startDb(dbLocationFolderPath);
  // watchBlocks(deepClone(ethereumNode));
  verifierFailedSubmissionsWatcher(dbLocationFolderPath);

  // switch to local node
  ethereumNode.nodeUrl = 'http://127.0.0.1:8545/';

  let endCursor: string | null = await getLastEndCursorDb();

  let count = 0;

  consoleLog('LENS VERIFICATION NODE - started up..');
  while (true) {
    try {
      const arweaveTransactions: getDataAvailabilityTransactionsAPIResponse =
        await getDataAvailabilityTransactionsAPI(
          ethereumNode.environment,
          ethereumNode.deployment,
          endCursor
        );

      if (arweaveTransactions.edges.length === 0) {
        consoleLog('LENS VERIFICATION NODE - No new DA items found..');
        // sleep for 100ms before checking again
        await sleep(100);
      } else {
        count++;
        consoleLog(
          'LENS VERIFICATION NODE - Found new submissions...',
          arweaveTransactions.edges.length
        );

        // do 1000 at a time to avoid I/O issues
        await checkDAProofsBatch(arweaveTransactions, ethereumNode, stream);

        endCursor = arweaveTransactions.pageInfo.endCursor;
        await saveEndCursorDb(endCursor!);

        console.log('completed count', count);
      }
    } catch (error) {
      consoleLog('LENS VERIFICATION NODE - Error while checking for new submissions', error);
      await sleep(100);
    }
  }
};
