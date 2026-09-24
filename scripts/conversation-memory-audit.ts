import { resolve } from "node:path";
import { ConversationMemoryStore, Store } from "@agent-bridge/database";

const databasePath = resolve(process.env.DATABASE_PATH ?? "./data/control-plane.sqlite");
const store = new Store(databasePath);
try {
  const memory = new ConversationMemoryStore(store.db);
  process.stdout.write(`${JSON.stringify(memory.audit(), null, 2)}\n`);
} finally { store.db.close(); }
