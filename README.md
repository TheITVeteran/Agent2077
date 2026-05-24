# Agent2077

A self-hosted AI agent workspace for local and OpenAI-compatible models. Agent2077 runs on your Linux machine and serves a full browser UI accessible from any device on your network. It gives an AI agent real tools — file editing, command execution, Docker app deployment, web search, memory, and the ability to improve its own codebase.

> **You are fully responsible for anything that happens by installing and using this tool.**

If Agent2077 is useful to you, consider supporting further development:
[ko-fi.com/latenightai](https://ko-fi.com/latenightai) *(current development cost: $1,283.46 USD)*

Discord: [discord.gg/3yTAQ4xEAr](https://discord.gg/3yTAQ4xEAr) — answers may vary depending on coffee supply.

![Agent2077 chat home](docs/screenshots/chat-home.png)

---

## Table of Contents

- [What it is](#what-it-is)
- [Requirements](#requirements)
- [Installation](#installation)
- [First login](#first-login)
- [Connecting a model](#connecting-a-model)
- [Features](#features)
  - [Chat](#chat)
  - [Workspace (Projects)](#workspace-projects)
  - [App Store](#app-store)
  - [Memory & Skills](#memory--skills)
  - [Multi-model orchestration](#multi-model-orchestration)
  - [Self-Dev mode](#self-dev-mode)
  - [Settings](#settings)
- [How the agent loop works](#how-the-agent-loop-works)
- [Architecture overview](#architecture-overview)
- [Security](#security)
- [Status & roadmap](#status--roadmap)
- [License](#license)

---

## What it is

Agent2077 is a locally-hosted AI agent with a web UI. You point it at any OpenAI-compatible model endpoint (LM Studio, OpenRouter, a remote vLLM server, etc.) and it becomes a capable agent that can:

- Chat and answer questions with access to web search
- Open projects and read, write, and edit code across a full file tree
- Execute shell commands and run tests
- Build web apps and games, containerize them with Docker, and serve them on your network
- Remember facts, store reusable skill instructions, and recall context across sessions
- Improve and modify its own codebase in Self-Dev mode

Everything runs on your own hardware. No cloud accounts required beyond whatever model endpoint you choose.

---

## Requirements

- **OS**: Linux (UI is accessible from Windows/Mac via browser)
- **Node.js**: 22+ (installed automatically by `install.sh` via nvm)
- **Docker**: optional but required for App Store and code execution
- **One LLM endpoint**:
  - [LM Studio](https://lmstudio.ai/) local server
  - [OpenRouter](https://openrouter.ai/)
  - Any OpenAI-compatible `/v1/chat/completions` endpoint

Agent2077 starts without Docker, but the App Store and code execution tools will be unavailable until Docker is running.

---

## Installation

Run the installer from the project root:

```bash
./install.sh
```

The installer handles everything: Docker, nvm/Node 22, nginx, Avahi mDNS, SearXNG (local search), npm dependencies, the production build, and a systemd service so Agent2077 starts on boot.

During install you'll be asked whether to enable LAN serving (makes the UI accessible from other machines on your network at `agent2077.local`).

After install, start Agent2077 at any time with:

```bash
./start.sh
```

### Accessing the UI

| Where | Address |
|---|---|
| Same machine | `http://localhost:5000` |
| Local network | `http://agent2077.local` |
| Direct IP | `http://<device-ip>:5000` |

> LAN serving can also be toggled later in **Settings → Network**.

---

## First login

Default credentials:

```
Username: Agent2077
Password: Agent2077
```

**Change the password immediately** in **Settings → Security** before exposing the app to your network.

---

## Connecting a model

Go to **Settings → API Endpoints** and add an endpoint:

| Provider | Base URL |
|---|---|
| LM Studio | `http://localhost:1234` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Any compatible | your `/v1/chat/completions` URL |

After adding an endpoint, click **Sync** to discover available models. Enable the models you want, then tag each one with its capabilities:

- **Tool calling** — can execute agent tools
- **Vision** — can process image inputs
- **Orchestrator** — used for planning and routing high-level tasks
- **Sub-agent** — used for delegated subtasks

---

## Features

### Chat

The main chat interface connects to the agent loop and gives the AI access to all registered tools. The agent automatically selects only the tools relevant to your request rather than flooding every prompt with the full tool list.

**What the agent can do from chat:**

- Search the web (via local SearXNG or a configured search tool)
- Read, create, and edit files on the host machine
- Run shell commands and scripts
- Recall and store memories across sessions
- Look up and apply skill instructions
- Build apps and add them to the App Store
- Spawn sub-agents for delegated tasks

---

### Workspace (Projects)

The Workspace is a project-aware coding environment. Create or open a project and the agent maintains separate context for it — file tree, recent edits, project-specific memory.

**Capabilities:**

- Browse and open any file in the project tree
- Read, edit, and create files with full diff awareness
- Run build commands, tests, and scripts
- Keep project notes and context separate from general chat memory
- Hand off multi-file tasks to sub-agents

Useful for: reviewing a codebase, implementing features, debugging, refactoring.

---

### App Store

The App Store lets the agent build web apps, tools, and games and serve them on your local network — each in its own Docker container.

**How to use it:**

1. In normal chat, ask the agent to build something and add it to the App Store:
   > *"Build me a Flappy Bird clone and add it to the App Store"*
   > *"Make a markdown editor and deploy it to the App Store"*
2. The agent writes the code, containerizes it, and registers it.
3. Open the App Store tab to see all deployed apps with launch links.
4. Each app is served at `agent2077.local:<port>` and accessible from any device on your network.

**App management:**

- Start / stop / delete apps from the App Store UI
- View build logs per app
- Apps persist across Agent2077 restarts

> Docker must be running for the App Store to work.

---

### Memory & Skills

**Memory** is persistent storage for facts the agent should remember across sessions. The agent can store and retrieve memories automatically, or you can manage them manually in Settings.

Examples of what gets stored:
- Your preferences and working style
- Project context and decisions made
- People, tools, and systems you've mentioned

**Skills** are reusable instruction sets for specific tasks. You can create a skill (e.g. "how to write a commit message", "our code review checklist") and the agent will find and apply it when relevant.

Skills are stored as text files and can be edited directly from the Skills UI.

---

### Multi-model orchestration

Register multiple model endpoints and Agent2077 will route tasks to the most appropriate model based on the tags you've assigned.

**Example setup:**
- Enable `Qwen3 30B` → tag it **coding**
- Enable `Gemma 31B` → tag it **research**

When you ask a research question, the Gemma model loads. When you switch to a coding task, it unloads Gemma and loads Qwen — automatically managing VRAM.

This is especially useful with LM Studio, which supports model hot-swapping.

**Other orchestration features:**

- Designate an **orchestrator model** for planning and task decomposition
- Assign models to specific **task types** (coding, research, vision, etc.)
- Benchmark model behavior from Settings
- Adjust the failed-tool-call cap before the agent gives up on a task

---

### Self-Dev mode

Self-Dev is an optional mode that gives Agent2077 tools to read and modify its own source code. It runs a separate dev server (port 5050, accessible at `devagent.local`) so changes don't affect the running production instance.

**Workflow:**

1. Switch to Self-Dev mode from the sidebar
2. The agent can read files, propose edits, run builds, and test changes in the dev environment
3. Once satisfied, use **Deploy to Production** to promote the dev build

**Deploy to Production:**
- Takes an automatic snapshot of the current production build first (so you can roll back)
- Copies the dev build to production
- Optionally migrates your data directory
- Runs `npm install` and builds
- Restarts Agent2077 automatically — the UI polls for the server to come back and reloads itself

**Version history & rollback:**
- Every deploy saves a timestamped snapshot to `~/agent2077-dev/releases/`
- The Rollback panel lists all saved releases with timestamps and dev branch info
- One click restores any previous version and restarts automatically

**Preview URLs** in the sidebar show the local and LAN addresses for the dev server so you can test from any device before promoting.

---

### Settings

| Section | What's there |
|---|---|
| **API Endpoints** | Add/remove model endpoints, sync models, configure keys |
| **Models** | Enable models, assign capability tags, set orchestrator |
| **Network** | Toggle LAN serving, configure hostname overrides |
| **Security** | Change password, set JWT secret |
| **Agent** | Smart tool selection, max failed tool calls, internet kill switch |
| **Memory** | View, search, and delete stored memories |
| **Skills** | Create, edit, and delete skill files |

**Notable toggles:**

- **Smart tool selection** (default: on) — sends only relevant tools per request instead of the full registry. Turn off if the agent is missing tools it should have.
- **Internet kill switch** — disables all outbound web/search tools while keeping local tools active. Useful for air-gapped or sensitive work.
- **OpenRouter balance floor** — optional spend guard; stops requests if your OpenRouter balance drops below a threshold.

---

## How the agent loop works

```
Browser UI
   │
   ▼
Express API (SSE stream)
   │
   ├── Request router         — classifies intent, picks route and tool subset
   ├── System prompt builder  — compact prompt with only relevant modules
   ├── Smart tool selector    — filters registry to current task context
   ├── Model call             — sends to the appropriate endpoint/model
   ├── Tool-call repair       — fixes malformed JSON tool calls before execution
   └── Failure classifier     — injects targeted recovery guidance on repeated failure
```

The pipeline is designed to keep local models responsive. Large tool registries and system prompts are the primary cause of degraded performance on local hardware — Agent2077 avoids both by keeping each request lean.

---

## Architecture overview

```
client/          React + Vite frontend (TypeScript)
server/          Express API, agent loop, tool registry
server/lib/      Core modules: agent, memory, skills, dev workspace, nginx
server/tools/    Individual tool implementations
shared/          Database schema and shared types
script/          Build and smoke-test scripts
scripts/         DB init and migration scripts
data/            SQLite database, memory files (gitignored)
docker/          Docker config templates
docs/            Screenshots and architecture docs
install.sh       Full system installer
start.sh         Launch script (with auto-restart loop)
```

**Key internals:**

- **Database**: SQLite via `better-sqlite3` — no external DB required
- **Auth**: JWT-based session tokens
- **App serving**: per-app nginx configs written to `<install-dir>/nginx-apps/` — no root access needed after install
- **mDNS**: Avahi daemon publishes `agent2077.local` on your LAN
- **Dev/prod separation**: dev server runs on port 5050, production on 5000; promote flow handles the swap safely

---

## Security

Agent2077 has real system access — shell execution, file editing, Docker, network. Treat it accordingly.

- **Change the default password** before putting it on a network
- **Keep LAN serving off** unless you need it, and only use it on a trusted private network
- **Set a strong `JWT_SECRET`** — change the default in `.env` or Settings
- **Never expose port 5000 directly to the internet** without a hardened reverse proxy and additional auth
- **Review Docker access** if multiple users share the host machine
- The **internet kill switch** in Settings disables outbound tools if you want to work in isolation

---

## Screenshots

| Chat | Workspace |
|---|---|
| ![Chat](docs/screenshots/chat-home.png) | ![Workspace](docs/screenshots/workspace.png) |

| App Store | Skills |
|---|---|
| ![App Store](docs/screenshots/app-store.png) | ![Skills](docs/screenshots/skills.png) |

| API endpoint settings |
|---|
| ![Settings](docs/screenshots/settings-api-endpoints.png) |

---

## Status & roadmap

Agent2077 is under active development by LateNightAI. Development is sporadic — features get added when they get added.

Things that exist and work:
- Chat with tool use
- Coding workspace
- App Store (Docker-backed)
- Memory and skills
- Multi-model orchestration
- Self-Dev mode with deploy/rollback
- LAN serving via mDNS

Things that may come eventually:
- ComfyUI image generation integration
- In-depth setup video on YouTube
- More app types in the App Store

If there's a feature you want, either open an issue or use Self-Dev mode to add it yourself.

---

## License

Agent2077 is licensed under the **GNU Affero General Public License v3.0**. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries: [JustLateNightAI@gmail.com](mailto:JustLateNightAI@gmail.com)
