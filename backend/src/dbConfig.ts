import { config as SQLConfig } from "mssql";

const dbConfig: SQLConfig = {
  user: 'admin',       // SQL Server username
  password: 'tOFyht7ikjm6MufPydcW',   // SQL Server password
  server: 'medintake.cbqy04mga9aw.eu-north-1.rds.amazonaws.com',            // or the IP/hostname of your SQL Server
  port: 1433,          // default SQL Server port
  database: 'MEDSUB',
  options: {
    encrypt: true,               // required for Azure
    trustServerCertificate: true // for local dev / self-signed certs
  }
};

export default dbConfig;

