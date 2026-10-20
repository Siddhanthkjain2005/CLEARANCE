# Clearance — project story

**Tagline:** Every change is a flight. Understand its journey, its risk and the decision behind its clearance.

**Live interface:** [Clearance](https://clearance-tower-30123867341.northamerica-northeast1.run.app/)

**Source:** [Siddhanthkjain2005/CLEARANCE](https://github.com/Siddhanthkjain2005/CLEARANCE)

## Inspiration

Software delivery produces plenty of information, but understanding it often means moving between issues, reviews, pipelines and monitoring screens. We wanted a shared view that helps a person see what is progressing, what is waiting and why a decision was made.

Air traffic control offered a consistent visual language. Every change becomes a flight, its author becomes a pilot, and the route to production becomes an approach through nine gates. The idea connects an expressive 3D world with practical controls for finding and understanding changes.

## What it does

Clearance is a working web interface with a guided landing page and an interactive delivery dashboard.

The landing page introduces the product through a scroll-driven journey. Numbered chapters explain the delivery stages while the camera follows the approach. Direct links let visitors enter the tower or explore the decision model at their own pace.

Inside the tower, a searchable flight board sits alongside the 3D airspace. Visitors can filter flights, select a change, read its clearance explanation and inspect its risk signals and stage history. Camera presets reveal the airport, river district and tower, while a follow view stays with a selected flight.

The Trust ledger explains the pilot records used by the governor. The Carbon view presents a modelled footprint with explicit assumptions. The Governor playground lets visitors edit a proposed change and see the resulting decision, making policy understandable through interaction.

## Design approach

The interface moves from overview to detail. The 3D scene gives a shared spatial context; summary instruments and flight strips support scanning; the inspector provides the explanation behind an individual result. Expand controls let visitors give more space to either the world or the information panel.

A dark instrument palette keeps text readable over the landscape. Mint, amber and rose accents support state recognition, with written status labels carrying the same meaning. Manrope and IBM Plex Mono distinguish narrative content from identifiers and telemetry.

The procedural setting includes an airport, aircraft, vehicles, city blocks, roads, terrain, vegetation, a river, lake and ponds. Holding and go-around paths communicate different delivery states. The world is fictional, and water uses visual shading and reflection effects.

## Accessibility and inclusion

The implementation includes labelled HTML controls, visible focus styles, selected-state attributes, text alternatives for stage tracks, search by keyboard and reduced-motion preferences. Responsive panels and expansion controls support different reading contexts. Operational information remains available in HTML alongside the canvas.

These are implemented design provisions. A complete accessibility audit and participant usability study have not been conducted. The [design case study](../design-case-study.md) documents the current evidence and a proposed evaluation plan.

## How we built it

The browser uses TypeScript, React-compatible components rendered by Preact, CSS and a custom WebGL2/GLSL renderer. Procedural geometry, instancing, culling and adaptive effects support the detailed environment within an enforced 160 KiB gzip budget for the built JavaScript, CSS and HTML.

A Node.js Tower provides state and server-sent events. The deterministic engine evaluates risk, trust and the service's error budget, then explains the permitted clearance level. The same engine powers the Governor playground and command-line tools.

The repository includes optional GitLab Duo flow definitions, CI/CD integration, evidence-chain tools and Cloud Run deployment support. The public interface is hosted on Google Cloud Run with clearly labelled simulated traffic. Live GitLab agents and pipelines are not connected to this preview.

## Challenges

- Making an expressive spatial interface useful for precise operational tasks.
- Keeping status, clearance, trust and risk distinguishable without overwhelming a first-time visitor.
- Explaining a complex policy through editable examples and clear result text.
- Balancing world detail, motion, responsive reading space and a small transfer budget.
- Separating simulated preview data, tested implementation and optional live integrations in the presentation.

## Accomplishments

Clearance brings a guided product story, a procedural 3D environment and an explainable decision dashboard into one working interface. Search, filters, inspectors, analytical views and a what-if playground give visitors concrete ways to explore the idea.

The repository contains reproducible checks for TypeScript, the decision engine, world geometry, production builds, documentation links, bundle size and server behavior. Those checks establish implementation behavior; they do not establish a measured usability improvement.

## What we learned

A visual metaphor becomes useful when it helps someone make the next decision. Repeated vocabulary, clear navigation and readable explanations matter as much as the scene. The interface also needs to show where a value comes from, especially when demonstrating simulated traffic or modelled carbon figures.

## What's next

Evaluate whether new visitors can find a held change, explain its reason and use the playground to predict another outcome. Follow that with a full accessibility review, lower-powered-device testing and optional live GitLab integration. Use observed results to simplify any interactions that add effort.

## Built with

TypeScript, Preact, React-compatible TSX, CSS, WebGL2, GLSL, esbuild, Node.js 22, server-sent events, Google Cloud Run, Cloud Build and Artifact Registry. Optional integration: GitLab CI/CD, GitLab Duo flow definitions, Model Context Protocol and Terraform.
