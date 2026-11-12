import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, readMemory, doctorState } from "@/lib/career-ops";
import { profileRef } from "@/lib/core/profile-path.mjs";
import { buildSystemPreamble } from "@/lib/assistant-preamble.mjs";

export const runtime = "nodejs"; // child_process (spawn) requires the Node runtime
export const dynamic = "force-dynamic";
export const maxDuration = 120;



type Msg = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  let body: { message?: string; cliId?: string; history?: Msg[]; pageContext?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const { message, cliId, pageContext } = body;
  if (!message || !cliId) {
    return new Response(JSON.stringify({ error: "message and cliId required" }), { status: 400 });
  }

  const resolved = resolveCli(cliId);
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found on this machine` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;

  const history = (body.history ?? []).slice(-8);
  const convo = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
  const pageLine = pageContext
    ? `\n\nCURRENT PAGE (the user is looking at this right now): ${pageContext}\nWhen the user's message is ambiguous ("this", "it", "apply", "evaluate this", "draft it"), assume it refers to what's on the current page.`
    : "";
  const memory = readMemory();
  const memoryLine = memory.trim()
    ? `\n\nWHAT YOU KNOW ABOUT THE USER (persistent memory — carries across sessions and CLIs):\n${memory.trim()}`
    : "\n\n(No persistent memory about the user yet — learn and use <<remember:>> as you go.)";
  // Hand the assistant the SAME authoritative setup signal the home screen reads
  // (doctorState), so it never re-asks for a file that already exists (disc#7) —
  // the home was correctly nudging for the missing PROFILE while the assistant,
  // given no state, restarted its onboarding script and asked for the CV again.
  const { hasCv, onboardingNeeded, missing } = doctorState();
  const setupLine = onboardingNeeded
    ? `\n\nSETUP STATE (authoritative — the SAME signal the home screen uses; trust it over guessing, and do NOT re-ask for anything already on file):\n- CV on file (cv.md): ${hasCv ? "YES — do NOT ask for it again; read it to be concrete" : "NO — this is the first thing to collect"}\n- Still missing: ${missing.length ? missing.join(", ") : "nothing"}\nWhen onboarding, START at the first item actually missing. If the CV is already on file, SKIP step 1 entirely and go straight to the next missing prerequisite (usually the profile — target roles, comp, location).`
    : `\n\nSETUP STATE: this user is fully set up (CV + profile + scanner all on file). Do NOT run onboarding or ask for a CV — just help them with what they actually asked.`;
  const preamble = buildSystemPreamble(profileRef(careerOpsRoot()));
  const prompt = `${preamble}${setupLine}${memoryLine}${pageLine}\n\n--- Conversation ---\n${convo}\nUser: ${message}\nAssistant:`;

  // Claude Code streams token-level deltas via stream-json + partial messages.
  // Other CLIs: pass their stdout through raw.
  // The chat CLI is READ-ONLY: all writes go through gated registry actions
  // (remember → /api/memory, setStatus → /api/status), never the CLI editing
  // files directly. Scope its tools so it can advise (read) but not blind-write.
  const isClaude = cliId === "claude";
  // allowedTools must be COMMA-separated; disallowedTools is the hard guardrail
  // so the advisor can read (and WebFetch) but never blind-writes or shells out.
  const args = isClaude
    ? [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,WebFetch,Glob,Grep",
        "--disallowedTools",
        "Bash,Write,Edit,NotebookEdit,Task",
      ]
    : spec.args(prompt);

  const child = spawnHeadlessCli(binPath, args, { cwd: careerOpsRoot(), env: process.env });

  const encoder = new TextEncoder();
  // `closed` + kill timer in the OUTER scope so cancel() can flip `closed` before
  // the child's late handlers run — otherwise they enqueue onto an already-closed
  // controller and throw an uncaught "Controller is already closed" (see #1155).
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emitted = false;
      killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, 90_000);
      const safeClose = () => {
        if (!closed) {
          closed = true;
          if (killer) clearTimeout(killer);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      const safeEnqueue = (s: string): boolean => {
        if (closed || !s) return false;
        try {
          controller.enqueue(encoder.encode(s));
          return true;
        } catch {
          closed = true; // controller already closed underneath us — stop, never crash
          return false;
        }
      };
      const emit = (s: string) => {
        if (safeEnqueue(s)) emitted = true;
      };

      child.stdout.on("data", (d: Buffer) => {
        if (closed) return;
        if (!isClaude) {
          emit(d.toString());
          return;
        }
        // line-buffered NDJSON → emit only assistant text deltas
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "stream_event" && obj.event?.type === "content_block_delta") {
              const text = obj.event.delta?.text;
              if (typeof text === "string") emit(text);
            }
          } catch {
            /* partial / non-json line — skip */
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        if (/error|not found|denied|fatal/i.test(s)) {
          safeEnqueue(`\n[${spec.name}] ${s.trim()}\n`);
        }
      });
      child.on("error", (e) => {
        safeEnqueue(`\n[error launching ${spec.name}: ${e.message}]`);
        safeClose();
      });
      child.on("close", () => {
        if (!emitted) {
          safeEnqueue("_(no output — is the CLI authenticated?)_");
        }
        safeClose();
      });
    },
    cancel() {
      closed = true;
      if (killer) clearTimeout(killer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
