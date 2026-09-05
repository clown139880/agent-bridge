import {
  createClient,
  EventType,
  MsgType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  RoomEvent,
  Visibility,
} from "matrix-js-sdk";
import { marked } from "marked";
import pino from "pino";
import sanitizeHtml from "sanitize-html";

const log = pino({ name: "matrix" });

export interface MatrixCallbacks {
  onRoomMessage(body: string, sender: string, eventId: string): Promise<void>;
  onThreadMessage(roomId: string, threadRootId: string, body: string, sender: string): Promise<void>;
  onReaction(targetEventId: string, key: string, sender: string): Promise<void>;
}

export class MatrixGateway {
  readonly enabled = true;
  private client!: MatrixClient;
  private roomId = "";
  private startedAt = Date.now();
  private readonly sentEventIds = new Set<string>();

  constructor(
    private readonly options: {
      homeserver: string;
      userId: string;
      password: string;
      roomId?: string;
      roomName: string;
      allowedUserId?: string;
    },
    private readonly callbacks: MatrixCallbacks,
  ) {}

  async start(): Promise<string> {
    this.client = createClient({ baseUrl: this.options.homeserver });
    const login = await this.client.login("m.login.password", {
      identifier: { type: "m.id.user", user: this.options.userId },
      password: this.options.password,
    });
    this.client = createClient({
      baseUrl: this.options.homeserver,
      accessToken: login.access_token,
      userId: login.user_id,
      deviceId: login.device_id,
    });
    this.roomId = this.options.roomId ?? await this.createControlRoom();
    this.client.on(RoomEvent.Timeline, (event: MatrixEvent) => void this.handleTimeline(event));
    await this.client.startClient({ initialSyncLimit: 20 });
    log.info({ roomId: this.roomId }, "Matrix gateway started");
    return this.roomId;
  }

  stop(): void {
    this.client?.stopClient();
  }

  async sendRoot(body: string, metadata?: AgentBridgeMetadata): Promise<string> {
    const response = await this.client.sendEvent(
      this.roomId,
      EventType.RoomMessage,
      withMetadata(markdownMessageContent(MsgType.Text, body), metadata),
    );
    this.rememberSent(response.event_id);
    return response.event_id;
  }

  async sendThread(threadRootId: string, body: string, metadata?: AgentBridgeMetadata): Promise<string> {
    const response = await this.client.sendEvent(this.roomId, EventType.RoomMessage, {
      ...markdownMessageContent(MsgType.Text, body),
      "m.relates_to": {
        rel_type: RelationType.Thread,
        event_id: threadRootId,
        is_falling_back: true,
        "m.in_reply_to": { event_id: threadRootId },
      },
      ...(metadata ? { "io.agent-bridge": metadata } : {}),
    } as never);
    this.rememberSent(response.event_id);
    return response.event_id;
  }

  async sendReaction(targetEventId: string, key: string): Promise<string> {
    const response = await this.client.sendEvent(this.roomId, EventType.Reaction, {
      "m.relates_to": {
        rel_type: RelationType.Annotation,
        event_id: targetEventId,
        key,
      },
    });
    this.rememberSent(response.event_id);
    return response.event_id;
  }

  async removeReaction(eventId: string): Promise<void> {
    await this.client.redactEvent(this.roomId, eventId);
  }

  async sendNotice(body: string, metadata?: AgentBridgeMetadata): Promise<string> {
    const response = await this.client.sendEvent(
      this.roomId,
      EventType.RoomMessage,
      withMetadata(markdownMessageContent(MsgType.Notice, body), metadata),
    );
    this.rememberSent(response.event_id);
    return response.event_id;
  }

  private async createControlRoom(): Promise<string> {
    const response = await this.client.createRoom({
      name: this.options.roomName,
      topic: "Mobile control room for coding agents",
      visibility: Visibility.Private,
      invite: this.options.allowedUserId && this.options.allowedUserId !== this.options.userId
        ? [this.options.allowedUserId]
        : undefined,
      initial_state: [{ type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } }],
    });
    return response.room_id;
  }

  private async handleTimeline(event: MatrixEvent): Promise<void> {
    if (event.getRoomId() !== this.roomId) return;
    if (event.getTs() < this.startedAt - 5_000 || this.sentEventIds.has(event.getId() ?? "")) return;
    const sender = event.getSender() ?? "";
    if (this.options.allowedUserId && sender !== this.options.allowedUserId) return;
    if (event.getType() === EventType.Reaction) {
      const content = event.getContent<{ "m.relates_to"?: { rel_type?: string; event_id?: string; key?: string } }>();
      const relation = content["m.relates_to"];
      if (relation?.rel_type === RelationType.Annotation && relation.event_id && relation.key) {
        await this.callbacks.onReaction(relation.event_id, relation.key, sender);
      }
      return;
    }
    if (event.getType() !== EventType.RoomMessage) return;
    const content = event.getContent<{ body?: string; msgtype?: string; "m.relates_to"?: { rel_type?: string; event_id?: string } }>();
    if (content.msgtype !== "m.text" || !content.body) return;
    const relation = content["m.relates_to"];
    if (relation?.rel_type === "m.thread" && relation.event_id) {
      await this.callbacks.onThreadMessage(this.roomId, relation.event_id, content.body, sender);
    } else {
      const eventId = event.getId();
      if (eventId) await this.callbacks.onRoomMessage(content.body, sender, eventId);
    }
  }

  private rememberSent(eventId: string): void {
    this.sentEventIds.add(eventId);
    setTimeout(() => this.sentEventIds.delete(eventId), 60_000).unref();
  }
}

export class NoopMatrixGateway {
  readonly enabled = false;

  async start(): Promise<string> { return ""; }
  stop(): void {}
  async sendRoot(): Promise<string> { return ""; }
  async sendThread(): Promise<string> { return ""; }
  async sendReaction(): Promise<string> { return ""; }
  async removeReaction(): Promise<void> {}
  async sendNotice(): Promise<string> { return ""; }
}

export type ControlGateway = Pick<MatrixGateway,
  "start" | "stop" | "sendRoot" | "sendThread" | "sendReaction" | "removeReaction" | "sendNotice"
> & { enabled?: boolean };

export type AgentBridgeMetadata = Record<string, string | number | boolean | undefined>;

function withMetadata<T extends object>(content: T, metadata?: AgentBridgeMetadata): T & { "io.agent-bridge"?: AgentBridgeMetadata } {
  return metadata ? { ...content, "io.agent-bridge": metadata } : content;
}

export function markdownMessageContent(msgtype: MsgType.Text | MsgType.Notice, body: string): {
  msgtype: MsgType.Text | MsgType.Notice;
  body: string;
  format: "org.matrix.custom.html";
  formatted_body: string;
} {
  return {
    msgtype,
    body,
    format: "org.matrix.custom.html",
    formatted_body: markdownToMatrixHtml(body),
  };
}

export function markdownToMatrixHtml(markdown: string): string {
  const rendered = marked.parse(markdown, {
    async: false,
    breaks: true,
    gfm: true,
  });
  return sanitizeHtml(rendered, {
    allowedTags: [
      "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
      "strong", "em", "del", "blockquote", "pre", "code",
      "ul", "ol", "li", "hr", "a", "table", "thead", "tbody",
      "tr", "th", "td",
    ],
    allowedAttributes: {
      a: ["href"],
      code: ["class"],
    },
    allowedClasses: {
      code: [/^language-[A-Za-z0-9_+-]+$/],
    },
    allowedSchemes: ["http", "https", "mailto", "matrix"],
    allowProtocolRelative: false,
  }).trim();
}
