import { Identity } from 'spacetimedb';
import { DbConnection, ErrorContext } from './module_bindings/index.js';

const HOST = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? 'gridforgood';

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .onConnect((_conn: DbConnection, identity: Identity) => {
    console.log('GridForGood dev client connected.');
    console.log(`Node identity: ${identity.toHexString()}`);
  })
  .onDisconnect(() => {
    console.log('Disconnected from SpacetimeDB.');
  })
  .onConnectError((_ctx: ErrorContext, error: Error) => {
    console.error('Connection error:', error);
    process.exit(1);
  })
  .build();
