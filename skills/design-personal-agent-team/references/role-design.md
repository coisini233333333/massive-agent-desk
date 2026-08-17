# Role and model design guide

## Start from recurring lanes

Group work by the context and verification method an agent needs, not by every noun in a task.

| Lane | Strong role shape | Typical verification |
|---|---|---|
| Source discovery | read-only research scout | primary links, dates, claim-to-source map |
| Scientific reasoning | method/equation specialist | derivations, assumptions, reproduction plan |
| ML implementation | experiment engineer | unit tests, smoke training, metric artifacts |
| Hardware/embedded | timing and protocol engineer | compile/lint, timing math, bench checklist |
| Software product | implementation owner | tests, build, UI smoke checks |
| Independent assurance | reviewer/verifier | diff review, regression and evidence audit |
| Artifact delivery | technical writer | rendered document visual QA |

Merge two lanes when they share most tools and context. Split them when mistakes require different verification or prompts become dominated by unrelated exceptions.

## Model heuristics

- Use the strongest reasoning model for architecture, scientific synthesis, adversarial review, and ambiguous high-impact decisions.
- Use the balanced coding model for implementation, debugging, and sustained repository work.
- Use the efficient model for bounded search, inventory, formatting, and first-pass extraction.
- Configure a default model, but let explicit spawn choices override it for exceptional work.
- Validate model IDs and supported reasoning efforts from the runtime catalog; never hard-code an assumed future list in a client UI.

## Prompt checklist

Each custom agent prompt must define the decisions it owns, evidence it must gather, allowed writes, forbidden scope expansion, execution method, required verification, and handoff format. Avoid personality prose that does not change work quality.
