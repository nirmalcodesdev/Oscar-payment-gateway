import {
  AbiDecodingDataSizeInvalidError,
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";

import type { RuntimeConfig } from "../../config/environment.js";
import type {
  ChainLogEntry,
  ChainLogFilter,
  ObservedBlockHeader,
} from "../../domain/chain/chain-adapter.js";

const erc20MetadataAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

/** ERC-20 transfer event ABI used for canonical `Transfer` log filtering. */
export const erc20TransferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Canonical keccak256 topic of `Transfer(address indexed, address indexed, uint256)`. */
export const erc20TransferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface EvmTransactionReceipt {
  readonly blockNumber: number;
  readonly blockHash: string;
}

export interface RpcProviderReference {
  readonly providerId: string;
  readonly operatorId: string;
}

export type RegistryVerificationFailureReason =
  | "provider_configuration"
  | "provider_unavailable"
  | "wrong_chain"
  | "provider_disagreement"
  | "contract_missing"
  | "contract_invalid"
  | "decimal_mismatch"
  | "symbol_mismatch";

export class RegistryVerificationError extends Error {
  public readonly reason: RegistryVerificationFailureReason;

  public constructor(reason: RegistryVerificationFailureReason) {
    super("Registry verification failed");
    this.name = "RegistryVerificationError";
    this.reason = reason;
  }
}

interface TokenMetadataRead {
  readonly symbol?: string;
  readonly decimals: number;
  readonly totalSupply?: bigint;
  readonly nonStandard: readonly ("symbol" | "totalSupply")[];
}

export interface EvmProviderClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBytecode(
    address: Address,
    blockNumber: bigint,
  ): Promise<`0x${string}` | undefined>;
  readTokenMetadata(address: Address, blockNumber: bigint): Promise<TokenMetadataRead>;
  getBlockHeader(blockNumber: bigint): Promise<ObservedBlockHeader>;
  getLogs(filter: ChainLogFilter): Promise<readonly ChainLogEntry[]>;
  getTransactionReceipt(
    transactionHash: `0x${string}`,
  ): Promise<EvmTransactionReceipt | undefined>;
  readErc20Balance(
    contract: Address,
    holder: Address,
    blockNumber: bigint,
  ): Promise<bigint>;
  readErc20Decimals(contract: Address, blockNumber: bigint): Promise<number>;
}

export interface EvmProviderClientFactory {
  create(providerId: string, url: string, timeoutMs: number): EvmProviderClient;
}

export function containsNonStandardContractError(error: unknown): boolean {
  const isNonStandard = (nested: unknown) =>
    nested instanceof ContractFunctionRevertedError ||
    nested instanceof ContractFunctionZeroDataError ||
    nested instanceof AbiDecodingDataSizeInvalidError ||
    nested instanceof AbiDecodingDataSizeTooSmallError ||
    nested instanceof AbiDecodingZeroDataError;
  if (isNonStandard(error)) return true;
  return error instanceof BaseError && error.walk(isNonStandard) !== null;
}

async function optionalContractRead<T>(
  operation: () => Promise<T>,
): Promise<{ readonly value?: T; readonly nonStandard: boolean }> {
  try {
    return { value: await operation(), nonStandard: false };
  } catch (error: unknown) {
    if (containsNonStandardContractError(error)) return { nonStandard: true };
    throw error;
  }
}

class ViemEvmProviderClient implements EvmProviderClient {
  readonly #client: PublicClient;

  public constructor(url: string, timeoutMs: number) {
    this.#client = createPublicClient({
      transport: http(url, { retryCount: 0, timeout: timeoutMs }),
    });
  }

  public getChainId(): Promise<number> {
    return this.#client.getChainId();
  }

  public getBlockNumber(): Promise<bigint> {
    return this.#client.getBlockNumber({ cacheTime: 0 });
  }

  public getBytecode(
    address: Address,
    blockNumber: bigint,
  ): Promise<`0x${string}` | undefined> {
    return this.#client.getCode({ address, blockNumber });
  }

  public async readTokenMetadata(
    address: Address,
    blockNumber: bigint,
  ): Promise<TokenMetadataRead> {
    const decimals = await this.#client.readContract({
      address,
      abi: erc20MetadataAbi,
      functionName: "decimals",
      blockNumber,
    });
    const symbol = await optionalContractRead(() =>
      this.#client.readContract({
        address,
        abi: erc20MetadataAbi,
        functionName: "symbol",
        blockNumber,
      }),
    );
    const totalSupply = await optionalContractRead(() =>
      this.#client.readContract({
        address,
        abi: erc20MetadataAbi,
        functionName: "totalSupply",
        blockNumber,
      }),
    );
    return {
      decimals,
      ...(symbol.value === undefined ? {} : { symbol: symbol.value }),
      ...(totalSupply.value === undefined ? {} : { totalSupply: totalSupply.value }),
      nonStandard: [
        ...(symbol.nonStandard ? (["symbol"] as const) : []),
        ...(totalSupply.nonStandard ? (["totalSupply"] as const) : []),
      ],
    };
  }

  public async getBlockHeader(blockNumber: bigint): Promise<ObservedBlockHeader> {
    const block = await this.#client.getBlock({ blockNumber });
    return {
      blockNumber: Number(block.number),
      blockHash: block.hash,
      parentHash: block.parentHash,
    };
  }

  public async getLogs(filter: ChainLogFilter): Promise<readonly ChainLogEntry[]> {
    if (filter.transferTopic !== erc20TransferTopic) {
      throw new Error("Unsupported log filter topic");
    }
    const logs = await this.#client.getLogs({
      address: [...filter.contractAddresses] as Address[],
      event: erc20TransferAbi[0],
      fromBlock: BigInt(filter.fromBlock),
      toBlock: BigInt(filter.toBlock),
    });
    return logs.map((log) => ({
      contractAddress: log.address,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: Number(log.blockNumber),
      blockHash: log.blockHash,
      topics: log.topics,
      data: log.data,
      raw: {
        address: log.address,
        topics: [...log.topics],
        data: log.data,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        blockHash: log.blockHash,
        blockNumber: log.blockNumber.toString(),
        logIndex: log.logIndex,
        removed: log.removed,
      },
    }));
  }

  public async getTransactionReceipt(
    transactionHash: `0x${string}`,
  ): Promise<EvmTransactionReceipt | undefined> {
    try {
      const receipt = await this.#client.getTransactionReceipt({
        hash: transactionHash,
      });
      return {
        blockNumber: Number(receipt.blockNumber),
        blockHash: receipt.blockHash,
      };
    } catch (error: unknown) {
      if (containsNotFoundError(error)) return undefined;
      throw error;
    }
  }

  public readErc20Balance(
    contract: Address,
    holder: Address,
    blockNumber: bigint,
  ): Promise<bigint> {
    return this.#client.readContract({
      address: contract,
      abi: erc20MetadataAbi,
      functionName: "balanceOf",
      args: [holder],
      blockNumber,
    });
  }

  public readErc20Decimals(contract: Address, blockNumber: bigint): Promise<number> {
    return this.#client.readContract({
      address: contract,
      abi: erc20MetadataAbi,
      functionName: "decimals",
      blockNumber,
    });
  }
}

function containsNotFoundError(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const isNotFound = (nested: unknown) =>
    nested instanceof Error && nested.name.endsWith("NotFoundError");
  return isNotFound(error) || error.walk(isNotFound) !== null;
}

export const viemProviderClientFactory: EvmProviderClientFactory = {
  create(_providerId, url, timeoutMs) {
    return new ViemEvmProviderClient(url, timeoutMs);
  },
};

export interface TokenVerificationResult {
  readonly classification: "verified" | "manual_review";
  readonly normalizedAddress: Address;
  readonly symbol?: string;
  readonly decimals: number;
  readonly totalSupply?: string;
  readonly nonStandardReads: readonly ("symbol" | "totalSupply")[];
  readonly verifiedBlockNumber: string;
}

interface ResolvedProvider {
  readonly reference: RpcProviderReference;
  readonly client: EvmProviderClient;
}

function allEqual(values: readonly unknown[]): boolean {
  return values.length > 0 && values.every((value) => value === values[0]);
}

export class EvmRegistryVerifier {
  readonly #config: RuntimeConfig["rpc"];
  readonly #factory: EvmProviderClientFactory;

  public constructor(
    config: RuntimeConfig["rpc"],
    factory: EvmProviderClientFactory = viemProviderClientFactory,
  ) {
    this.#config = config;
    this.#factory = factory;
  }

  #resolveProviders(references: readonly RpcProviderReference[]): ResolvedProvider[] {
    const providerIds = new Set<string>();
    const operatorIds = new Set<string>();
    const resolved = references.map((reference) => {
      const configured = this.#config.providers[reference.providerId];
      if (
        configured === undefined ||
        configured.operatorId !== reference.operatorId ||
        providerIds.has(reference.providerId)
      ) {
        throw new RegistryVerificationError("provider_configuration");
      }
      providerIds.add(reference.providerId);
      operatorIds.add(reference.operatorId);
      return {
        reference,
        client: this.#factory.create(
          reference.providerId,
          configured.url,
          this.#config.requestTimeoutMs,
        ),
      };
    });
    if (resolved.length < 2 || operatorIds.size < 2) {
      throw new RegistryVerificationError("provider_configuration");
    }
    return resolved;
  }

  async #verifyChainWithProviders(
    expectedChainId: number,
    providers: readonly ResolvedProvider[],
  ): Promise<void> {
    let chainIds: number[];
    try {
      chainIds = await Promise.all(
        providers.map((provider) => provider.client.getChainId()),
      );
    } catch {
      throw new RegistryVerificationError("provider_unavailable");
    }
    if (!allEqual(chainIds)) {
      throw new RegistryVerificationError("provider_disagreement");
    }
    if (chainIds[0] !== expectedChainId) {
      throw new RegistryVerificationError("wrong_chain");
    }
  }

  public async verifyChain(
    expectedChainId: number,
    references: readonly RpcProviderReference[],
  ): Promise<void> {
    const providers = this.#resolveProviders(references);
    await this.#verifyChainWithProviders(expectedChainId, providers);
  }

  public async verifyToken(input: {
    readonly expectedChainId: number;
    readonly providerReferences: readonly RpcProviderReference[];
    readonly contractAddress: string;
    readonly expectedDecimals: number;
    readonly expectedSymbol: string;
  }): Promise<TokenVerificationResult> {
    let normalizedAddress: Address;
    try {
      normalizedAddress = getAddress(input.contractAddress);
    } catch {
      throw new RegistryVerificationError("contract_invalid");
    }
    const providers = this.#resolveProviders(input.providerReferences);
    await this.#verifyChainWithProviders(input.expectedChainId, providers);

    let blockNumbers: bigint[];
    try {
      blockNumbers = await Promise.all(
        providers.map((provider) => provider.client.getBlockNumber()),
      );
    } catch {
      throw new RegistryVerificationError("provider_unavailable");
    }
    const sharedBlock = blockNumbers.reduce((lowest, current) =>
      current < lowest ? current : lowest,
    );

    let bytecodes: (`0x${string}` | undefined)[];
    try {
      bytecodes = await Promise.all(
        providers.map((provider) =>
          provider.client.getBytecode(normalizedAddress, sharedBlock),
        ),
      );
    } catch {
      throw new RegistryVerificationError("provider_unavailable");
    }
    if (bytecodes.some((bytecode) => bytecode === undefined || bytecode === "0x")) {
      throw new RegistryVerificationError("contract_missing");
    }
    if (!allEqual(bytecodes)) {
      throw new RegistryVerificationError("provider_disagreement");
    }

    let metadata: TokenMetadataRead[];
    try {
      metadata = await Promise.all(
        providers.map((provider) =>
          provider.client.readTokenMetadata(normalizedAddress, sharedBlock),
        ),
      );
    } catch {
      throw new RegistryVerificationError("provider_unavailable");
    }
    const decimals = metadata.map((result) => result.decimals);
    if (!allEqual(decimals)) {
      throw new RegistryVerificationError("provider_disagreement");
    }
    if (decimals[0] !== input.expectedDecimals) {
      throw new RegistryVerificationError("decimal_mismatch");
    }

    const optionalReadOutcomes = metadata.map((result) =>
      [...result.nonStandard].sort().join(","),
    );
    if (!allEqual(optionalReadOutcomes)) {
      throw new RegistryVerificationError("provider_disagreement");
    }

    const availableSymbols = metadata.flatMap((result) =>
      result.symbol === undefined ? [] : [result.symbol.trim().toUpperCase()],
    );
    if (
      (availableSymbols.length > 0 && availableSymbols.length !== metadata.length) ||
      (availableSymbols.length > 0 && !allEqual(availableSymbols))
    ) {
      throw new RegistryVerificationError("provider_disagreement");
    }
    if (
      availableSymbols.length > 0 &&
      availableSymbols[0] !== input.expectedSymbol.trim().toUpperCase()
    ) {
      throw new RegistryVerificationError("symbol_mismatch");
    }

    const availableSupplies = metadata.flatMap((result) =>
      result.totalSupply === undefined ? [] : [result.totalSupply],
    );
    if (
      (availableSupplies.length > 0 && availableSupplies.length !== metadata.length) ||
      (availableSupplies.length > 0 && !allEqual(availableSupplies))
    ) {
      throw new RegistryVerificationError("provider_disagreement");
    }
    const nonStandardReads = [
      ...new Set(metadata.flatMap((result) => result.nonStandard)),
    ];
    return {
      classification: nonStandardReads.length === 0 ? "verified" : "manual_review",
      normalizedAddress,
      ...(availableSymbols[0] === undefined ? {} : { symbol: availableSymbols[0] }),
      decimals: decimals[0],
      ...(availableSupplies[0] === undefined
        ? {}
        : { totalSupply: availableSupplies[0].toString() }),
      nonStandardReads,
      verifiedBlockNumber: sharedBlock.toString(),
    };
  }
}
