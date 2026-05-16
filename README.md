# Messaging App Agent — Implementation Test

Implement the **AI agent** described in [`agent-interface.md`](agent-interface.md). This agent should interact with the already implemented Auth Service [`auth-interface.md`](auth-interface.md) and User Service [`user-interface.md`](user-interface.md). Even though the services are implemented in javascript, it exposes standard HTTP endpoints, so you can use any language and tech stack for the agent.

Your implementation should **NOT** touch Auth Service and User Service.

This is a timed exercise: use AI to help you finish the implementation in the time window. 

## What to build

Your agent should expose a Unix socket chat interface and handle the auth workflows defined in `agent-interface.md` (sign-up, login with MFA, password reset, TOTP enrollment, device management, profile updates, and user blocking). The agent must back these workflows by calling the appropriate HTTP endpoints.

## Quick check

The following is a smoke test to verify your implementation abide by the `agent-interface.md`.

```bash
node test-chat-functional.mjs
```

## How you will be evaluated

You will only be evaluated by how many workflows described in `agent-interface.md` your agent can pass.
