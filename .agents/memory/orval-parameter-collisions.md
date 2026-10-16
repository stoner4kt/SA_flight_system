---
name: Orval parameter collisions
description: Duplicate generated parameter type exports can make a workspace fail typechecking after otherwise successful OpenAPI code generation.
---

When an OpenAPI operation has query or path parameters, generated client and Zod modules can export colliding `*Params` names. Orval may report code generation as successful even though the generated libraries then fail typechecking.

**Why:** a duplicate generated parameter export caused a TypeScript conflict during API contract work in this workspace.

**How to apply:** After changing an OpenAPI contract, run code generation and workspace library typechecking. If generated parameter names collide, use explicitly named schemas or operation IDs, or keep the filtering client-side until a parameterized endpoint is necessary.
