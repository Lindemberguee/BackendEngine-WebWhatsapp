// Runs only when MongoDB initializes a brand-new /data/db volume.
// Keep the application account scoped to its own database; the root account is
// reserved for administration and disaster recovery.
const databaseName = process.env.MONGO_INITDB_DATABASE || 'webwhatsapp';
const username = process.env.MONGO_APP_USERNAME;
const password = process.env.MONGO_APP_PASSWORD;

if (!username || !password) {
  throw new Error('MONGO_APP_USERNAME and MONGO_APP_PASSWORD are required');
}

const applicationDb = db.getSiblingDB(databaseName);
if (!applicationDb.getUser(username)) {
  applicationDb.createUser({
    user: username,
    pwd: password,
    roles: [{ role: 'readWrite', db: databaseName }],
  });
}
