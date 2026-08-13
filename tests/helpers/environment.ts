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
    ...overrides,
  };
}
