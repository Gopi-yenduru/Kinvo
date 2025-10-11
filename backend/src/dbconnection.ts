import sql, { ConnectionPool } from "mssql";
import dbConfig from "./dbConfig.js";

// Create a single shared connection pool (singleton)
const poolPromise: Promise<ConnectionPool> = new sql.ConnectionPool(dbConfig)
  .connect()
  .then((pool) => {
    console.log("✅ Connected to SQL Server");
    return pool;
  })
  .catch((err) => {
    console.error("❌ Database connection failed:", err);
    throw err;
  });

export { sql, poolPromise };
