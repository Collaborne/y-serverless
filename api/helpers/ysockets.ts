import { ConnectionsTableHelper } from "./connections";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import * as Y from "yjs";

const messageSync = 0;
const messageAwareness = 1;

export class YSockets {
  private ct = new ConnectionsTableHelper();

  async onConnection(connectionId: string, docName: string) {
    const { ct } = this;
    await ct.createConnection(connectionId, docName);
    const doc = await ct.getOrCreateDoc(docName);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);

    // TODO: cannot send message during connection.. Need to broadcast likely
    // await send({ context, message: encoding.toUint8Array(encoder), id })

    console.log(`${connectionId} connected`);
  }

  async onDisconnect(connectionId: string) {
    const { ct } = this;
    await ct.removeConnection(connectionId);

    console.log(`${connectionId} disconnected`);
  }

  async onMessage(
    connectionId: string,
    message: Uint8Array,
    send: (id: string, message: Uint8Array) => Promise<void>
  ) {
    const { ct } = this;

    const docName = (await ct.getConnection(connectionId)).DocName;
    const connectionIds = await ct.getConnectionIds(docName);
    const otherConnectionIds = connectionIds.filter(
      (id) => id !== connectionId
    );
    const broadcast = (message: Uint8Array) => {
      return Promise.all(
        otherConnectionIds.map((id) => {
          return send(id, message);
        })
      );
    };

    const doc = await ct.getOrCreateDoc(docName);

    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      // Case sync1: Read SyncStep1 message and reply with SyncStep2 (send doc to client wrt state vector input)
      // Case sync2 or yjsUpdate: Read and apply Structs and then DeleteStore to a y instance (append to db, send to all clients)
      case messageSync:
        encoding.writeVarUint(encoder, messageSync);
        const messageType = decoding.readVarUint(decoder);
        switch (messageType) {
          case syncProtocol.messageYjsSyncStep1:
            syncProtocol.writeSyncStep2(
              encoder,
              doc,
              decoding.readVarUint8Array(decoder)
            );
            break;
          case syncProtocol.messageYjsSyncStep2:
          case syncProtocol.messageYjsUpdate:
            const update = decoding.readVarUint8Array(decoder);
            Y.applyUpdate(doc, update);
            await broadcast(message);
            await ct.updateDoc(docName, update);
            break;
          default:
            throw new Error("Unknown message type");
        }

        if (encoding.length(encoder) > 1) {
          await send(connectionId, encoding.toUint8Array(encoder));
        }
        break;
      case messageAwareness: {
        await broadcast(message);
        break;
      }
    }
  }
}

export default YSockets;
