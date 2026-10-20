# Clearance — design case study

**An immersive 3D workspace for understanding software delivery.**

[Explore the interface](https://clearance-tower-30123867341.northamerica-northeast1.run.app/) · [View the source](https://github.com/Siddhanthkjain2005/CLEARANCE) · [Watch-through script](demo/script.md)

![Clearance airspace and flight board](images/tower.jpg)

## Problem and intended audience

A delivery pipeline has many states, but a person often needs a simple answer: is this change moving safely, waiting for someone, or recovering from a problem? Issues, reviews, verification results and release signals usually live in separate views. An approval indicator alone does not explain the decision.

Clearance is designed for developers following their changes and reviewers deciding where to focus. Its task flows bring delivery progress, attention points and decision reasons together.

The design goal is to make progress, exceptions and decision reasons understandable in the same place, while giving a first-time visitor an approachable introduction.

## Central idea

Every software change is a flight. A pilot is its author. Nine gates represent its delivery stages. Cleared changes approach the runway, held changes circle, and a failed canary initiates a go-around.

The metaphor provides a consistent vocabulary across the landing page, world animation, flight board and inspector. Plain-language labels explain the actual software state alongside the aviation language. The model supports autonomous, supervised, assisted and hold decisions.

The procedurally generated airport, landscape and aircraft create a coherent fictional setting for the delivery journey.

## Information architecture

| View | Visitor's question | Primary interaction |
|---|---|---|
| Home | What is Clearance, and how does a change move? | Follow nine chapters or enter the tower directly |
| Airspace | What is happening, and what needs attention? | Search/filter the flight board and select a flight |
| Flight inspector | Why did this change receive this clearance? | Read risk signals, reasons, stage history and available evidence |
| Trust ledger | What track record informs the decision? | Compare pilot records and the autonomy threshold |
| Carbon | What is the estimated footprint of delivery work? | Read the modelled breakdown and regional assumptions |
| Governor | How would different inputs change the outcome? | Edit a proposed change or load one of six presets |

Each analytical view has a direct URL. The console keeps its navigation and scene while the content panel changes, preserving context between overview and detail.

## Three primary user journeys

### 1. Understand the product

The hero states the purpose and offers an immediate route into the tower. Visitors who want context can follow the flight path. A numbered route diagram introduces the stages before the larger chapters expand each one. Trust, policy and footprint sections connect the story to the actual console views.

Scrolling changes the camera's position along the approach. The written narrative remains ordinary HTML, so the explanation does not depend on interpreting the 3D scene.

### 2. Find a change and explain its state

The airspace opens with summary instruments and the flight board. Search matches flight identifiers, titles and pilots; filters narrow the list to airborne or holding traffic. Pressing `/` focuses search when the visitor is not typing into another field.

Selecting a strip opens an inspector containing the clearance, reasons and available risk, timeline, canary, carbon and evidence sections. Availability depends on the flight's current data. Back controls return to the board. Camera presets provide consistent viewpoints, and Follow becomes available after a flight is selected.

The board can expand for reading. The airspace can expand for exploration. These controls let the visitor choose which layer needs attention.

### 3. Learn a decision by changing its inputs

The Governor playground provides a concrete way to explore an otherwise abstract policy. Visitors can vary file paths and change sizes, pilot type, trust, error budget and scanner findings. Six presets offer useful starting points.

The result shows a clearance level, its reasons and the contributing risk signals. The explanation updates as inputs change. Playground edits do not persist production policy or alter a pilot's actual history.

## Visual system and hierarchy

The world uses dusk lighting, a distant horizon and an airport approach to support the delivery metaphor. Dark instrument panels create a stable reading surface over the scene. Mint, amber and rose accents distinguish favorable, caution and blocked states, with text labels carrying the meaning as well.

Manrope gives headings and body copy a consistent voice. IBM Plex Mono separates identifiers, timestamps and numerical readouts. Large headings introduce the idea; compact strips and structured tables support repeated operational scanning.

The hierarchy moves from a spatial overview to a compact summary, then to detailed evidence. Stage tracks, status labels and recurring pilot marks connect those layers.

![Airport terminal and runway](images/airport.jpg)

## World, motion and interaction

The setting includes an airport terminal, stands, runway markings, approach lighting, aircraft, service vehicles, roads, a city, vegetation and surrounding terrain. The river, lake and ponds use animated water shading and reflections.

Flight motion communicates state. Landing, holding and going around have distinct paths. Camera presets make it possible to explore without manually finding a useful angle. Pointer orbit and zoom provide additional control.

The custom WebGL2 renderer uses procedural geometry, instancing, visibility culling, shadows and adaptive effects. A small production transfer budget constrains the experience. The current recorded build is approximately 146 KiB gzipped for JavaScript, CSS and HTML against a 160 KiB budget; externally loaded fonts and rendering energy are outside that figure.

## Accessibility and responsive behavior

Implemented provisions include:

- Native links, buttons, labelled form controls and visible keyboard focus styles.
- Text status labels alongside color, named meters and descriptive stage summaries.
- Camera and filter buttons that expose selected state to assistive technology.
- A keyboard shortcut for search and focus handling when console panels change.
- Reduced-motion preferences in the interface and renderer.
- HTML flight information and analytical panels alongside the canvas.
- Responsive panel layouts and independent controls for expanding the scene or board.

Responsive styles adapt the interface to desktop and narrow mobile layouts. Expansion controls give reading panels additional space when needed.

## Implementation

The interface uses TypeScript and React-compatible TSX rendered by Preact, a lightweight History API router, CSS and a custom WebGL2/GLSL engine. A Node.js Tower supplies snapshots and server-sent events. The same deterministic risk/governor engine supports the playground, console and CLI.

The public demo uses simulated delivery traffic with the implemented decision engine. The verification suite exercises decision logic, world geometry, the build budget, server endpoints and integration fixtures. GitLab flow definitions and CI/CD configuration support connected deployments.

See [verification](verification.md), [deployment](deployment.md), [architecture](architecture.md) and [carbon methodology](sci-methodology.md) for implementation details.

## Design decisions

| Design goal | Implementation |
|---|---|
| Keep operational information readable | Persistent HTML panels, structured strips and an expandable board |
| Make exploration approachable | Camera presets, direct navigation and a guided landing-page journey |
| Explain a complex decision | Editable Governor inputs, presets and immediate reason text |
| Support different reading contexts | Responsive panels, visible focus and reduced-motion preferences |
| Balance detail and performance | Procedural geometry, instancing, culling, adaptive effects and a transfer budget |
