import { dirname, join, resolve } from "node:path";
import { ConversationMemoryStore, Store } from "@agent-bridge/database";

const databasePath = resolve(process.env.DATABASE_PATH ?? "./data/control-plane.sqlite");
const objectDir = resolve(process.env.CONVERSATION_OBJECT_DIR ?? join(dirname(databasePath), "conversation-objects"));
const store = new Store(databasePath);
try {
  const memory = new ConversationMemoryStore(store.db, objectDir);
  process.stdout.write(`${JSON.stringify(memory.audit(), null, 2)}\n`);
} finally { store.db.close(); }
