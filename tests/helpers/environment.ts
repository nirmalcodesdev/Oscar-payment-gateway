export function validEnvironment(
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    SERVICE_NAME: "oscar-payment-gateway-test",
    API_HOST: "127.0.0.1",
    API_PORT: "3000",
    SHUTDOWN_TIMEOUT_MS: "5000",
    MONGODB_URI: "mongodb://127.0.0.1:27017/oscar_test?replicaSet=rs0",
    MONGODB_REPLICA_SET: "rs0",
    MONGODB_CONNECT_TIMEOUT_MS: "5000",
    REDIS_URL: "redis://127.0.0.1:6379",
    REDIS_CONNECT_TIMEOUT_MS: "5000",
    QUEUE_PREFIX: "oscar-test",
    ADMIN_JWT_CURRENT_KEY_ID: "test-current-v1",
    ADMIN_JWT_CURRENT_SECRET: "test-admin-jwt-current-secret-value-0001",
    ADMIN_JWT_PREVIOUS_KEY_ID: "",
    ADMIN_JWT_PREVIOUS_SECRET: "",
    MERCHANT_STEP_UP_SECRET: "test-merchant-step-up-secret-value-0001",
    ADMIN_ACCESS_TTL_SEC: "600",
    ADMIN_REFRESH_TTL_SEC: "604800",
    MERCHANT_STEP_UP_TTL_SEC: "300",
    WALLET_NETWORK_ALLOWLIST:
      '{"ethereum-mainnet":"mainnet","ethereum-sepolia":"testnet"}',
    ...overrides,
  };
}
