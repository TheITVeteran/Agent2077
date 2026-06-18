/**
 * Document Tools — read/write/patch the CURRENT conversation's document canvas.
 *
 * The chat document canvas is a single Markdown document scoped to each
 * conversation (see documentStore + the right-side DocumentCanvas panel).
 * These tools let the agent read and edit that document when the user asks
 * ("write this up in the doc", "add a section", "revise the document",
 * "what's currently in the doc").
 *
 * SAFETY: every tool operates ONLY on context.conversationId. There is no
 * parameter for an arbitrary document id or filesystem path — the agent can
 * never reach another conversation's document or the filesystem through here.
 */
import { registerTool, type ToolResult, type ToolContext } from "./registry.js";
import { documentStore } from "../storage.js";

const MAX_DOC_CHARS = 200_000; // generous ceiling to prevent runaway growth

function emitStep(context: ToolContext, label: string, detail?: string) {
  context.onStep?.({
    type: "document",
    label,
    detail,
    status: "completed",
    timestamp: new Date().toISOString(),
  });
}

// ── document_read — read the current conversation's document ───────────
registerTool("document_read", {
  category: "file",
  maxResultSizeChars: MAX_DOC_CHARS,
  definition: {
    type: "function",
    function: {
      name: "document_read",
      description:
        "Read the current chat's document (the right-side document canvas). Use this when the user asks what's in the document, to review it before editing, or before adding/revising a section. Returns the document title and full Markdown content for THIS conversation only.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  async execute(_args, context): Promise<ToolResult> {
    try {
      const doc = documentStore.getByConversation(context.conversationId);
      if (!doc || (doc.content ?? "").trim().length === 0) {
        return {
          success: true,
          output: "The document for this conversation is currently empty. Use document_write to create its content.",
          metadata: { empty: true },
        };
      }
      emitStep(context, "Reading document", doc.title);
      return {
        success: true,
        output: `Title: ${doc.title}\nFormat: ${doc.format}\n\n${doc.content}`,
        metadata: { documentId: doc.id, title: doc.title, length: doc.content.length },
      };
    } catch (err: any) {
      return { success: false, output: `Failed to read document: ${err.message}` };
    }
  },
});

// ── document_write — replace the current conversation's document ───────
registerTool("document_write", {
  category: "file",
  maxResultSizeChars: 2000,
  definition: {
    type: "function",
    function: {
      name: "document_write",
      description:
        "Create or fully replace the current chat's document (the right-side document canvas) with new Markdown content. Use this to write up notes, draft a document, or rewrite the whole document. This OVERWRITES the existing content — to make a targeted change instead, use document_patch. Operates on THIS conversation's document only.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The full Markdown content to store as the document body." },
          title: { type: "string", description: "Optional document title. If omitted, the existing title is kept." },
        },
        required: ["content"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const content = String(args.content ?? "");
    const title = typeof args.title === "string" ? args.title : undefined;
    if (content.length > MAX_DOC_CHARS) {
      return { success: false, output: `Content too large (${content.length} chars, max ${MAX_DOC_CHARS}).` };
    }
    try {
      const doc = documentStore.upsert(context.conversationId, {
        content,
        ...(title !== undefined ? { title } : {}),
      });
      emitStep(context, "Updated document", doc.title);
      return {
        success: true,
        output: `Document "${doc.title}" updated (${content.length} chars).`,
        metadata: { documentId: doc.id, title: doc.title, length: content.length },
      };
    } catch (err: any) {
      return { success: false, output: `Failed to write document: ${err.message}` };
    }
  },
});

// ── document_patch — targeted edit of the current conversation's doc ───
registerTool("document_patch", {
  category: "file",
  maxResultSizeChars: 2000,
  definition: {
    type: "function",
    function: {
      name: "document_patch",
      description:
        "Make a targeted edit to the current chat's document (the right-side document canvas) without rewriting the whole thing. Use 'append' to add a section to the end, 'prepend' to add to the top, or 'replace' to substitute an exact existing snippet with new text. Prefer this over document_write when the user asks to add a section or revise part of the document. Operates on THIS conversation's document only.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["append", "prepend", "replace"],
            description: "append = add to end; prepend = add to top; replace = swap an exact existing snippet.",
          },
          text: { type: "string", description: "For append/prepend: the Markdown to add. For replace: the replacement text." },
          find: { type: "string", description: "For replace mode only: the exact existing text to find and replace." },
        },
        required: ["mode", "text"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const mode = String(args.mode ?? "");
    const text = String(args.text ?? "");
    const find = typeof args.find === "string" ? args.find : "";
    try {
      const existing = documentStore.getByConversation(context.conversationId);
      const current = existing?.content ?? "";
      let next: string;
      if (mode === "append") {
        next = current.length > 0 ? `${current.replace(/\s+$/, "")}\n\n${text}` : text;
      } else if (mode === "prepend") {
        next = current.length > 0 ? `${text}\n\n${current.replace(/^\s+/, "")}` : text;
      } else if (mode === "replace") {
        if (!find) return { success: false, output: "replace mode requires a non-empty 'find' string." };
        if (!current.includes(find)) {
          return { success: false, output: `Could not find the snippet to replace. The document was not changed. Use document_read to see current content.` };
        }
        next = current.replace(find, text);
      } else {
        return { success: false, output: `Unknown mode "${mode}". Use append, prepend, or replace.` };
      }
      if (next.length > MAX_DOC_CHARS) {
        return { success: false, output: `Resulting document too large (${next.length} chars, max ${MAX_DOC_CHARS}).` };
      }
      const doc = documentStore.upsert(context.conversationId, { content: next });
      emitStep(context, "Patched document", `${mode}`);
      return {
        success: true,
        output: `Document "${doc.title}" patched (${mode}). Now ${next.length} chars.`,
        metadata: { documentId: doc.id, mode, length: next.length },
      };
    } catch (err: any) {
      return { success: false, output: `Failed to patch document: ${err.message}` };
    }
  },
});
