const rootUsername = process.env.MONGO_ROOT_USERNAME;
const rootPassword = process.env.MONGO_ROOT_PASSWORD;
const appUsername = process.env.MONGO_APP_USERNAME;
const appPassword = process.env.MONGO_APP_PASSWORD;
const replicaSet = process.env.MONGO_REPLICA_SET;

if (!rootUsername || !rootPassword || !appUsername || !appPassword || !replicaSet) {
  throw new Error("MongoDB initialization environment is incomplete");
}

db.auth(rootUsername, rootPassword);

try {
  rs.status();
} catch (error) {
  if (error.codeName !== "NotYetInitialized") {
    throw error;
  }
  rs.initiate({
    _id: replicaSet,
    members: [{ _id: 0, host: "mongodb:27017" }],
  });
}

let primary = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const hello = db.adminCommand({ hello: 1 });
  if (hello.isWritablePrimary === true) {
    primary = true;
    break;
  }
  sleep(1000);
}

if (!primary) {
  throw new Error("MongoDB replica set did not elect a primary");
}

const admin = db.getSiblingDB("admin");
if (admin.getUser(appUsername) === null) {
  admin.createUser({
    user: appUsername,
    pwd: appPassword,
    roles: [{ role: "readWrite", db: "oscar_payment_gateway" }],
  });
}
