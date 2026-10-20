# Clearance — project story

**Every change is a flight. Understand its journey, its risk and the decision behind its clearance.**

[Live demo](https://clearance-tower-30123867341.northamerica-northeast1.run.app/) · [Source](https://github.com/Siddhanthkjain2005/CLEARANCE) · [Design case study](design-case-study.md)

## Inspiration

Understanding software delivery often means moving between issues, reviews, pipelines and monitoring screens. Clearance brings progress, attention points and decision reasons into one shared interface.

Air traffic control provides a consistent visual language: a change becomes a flight, its author becomes a pilot, and the route to production becomes an approach through nine gates.

## The experience

A scroll-driven landing page introduces the delivery journey. Numbered chapters explain the stages while the camera follows the approach. Visitors can explore the story or enter the tower directly.

Inside the console, a searchable flight board sits alongside the 3D airspace. Filters help visitors find airborne or holding changes. Selecting a flight opens its clearance explanation, risk signals and stage history. Camera presets reveal the airport, river district and tower; Follow stays with a selected flight.

The Trust ledger shows the track records used by the governor. Carbon presents a modelled delivery footprint. The Governor playground lets visitors edit a proposed change and see how the decision responds.

The public demo uses simulated delivery traffic with the implemented decision engine.

## Design decisions

- **Overview to detail:** the world supplies spatial context, flight strips support scanning, and the inspector explains an individual result.
- **Choice of focus:** separate expand controls give more room to the world or the reading panel.
- **Consistent visual language:** mint, amber and rose accents work alongside written status labels. Manrope and IBM Plex Mono distinguish narrative content from identifiers and telemetry.
- **Interaction as explanation:** editable Governor inputs turn policy into a concrete what-if experience.
- **Accessible controls:** labelled HTML, visible keyboard focus, selected-state attributes, stage summaries and reduced-motion preferences support the main flows.
- **Responsive presentation:** panels and camera controls adapt to different viewport sizes.

The procedural setting includes an airport, aircraft, service vehicles, city blocks, roads, terrain, vegetation, a river, lake and ponds. Holding and go-around paths connect motion to delivery state.

## Implementation

TypeScript, Preact, CSS and a custom WebGL2/GLSL renderer power the browser. Procedural geometry, instancing, culling and adaptive effects support the detailed environment within a 160 KiB gzip budget for production JavaScript, CSS and HTML.

A Node.js Tower provides snapshots and server-sent events. The deterministic engine evaluates risk, trust and error budget, then explains the clearance. The same engine powers the playground and CLI.

The repository also provides GitLab workflow definitions, CI/CD integration, evidence-chain tools and Cloud Run deployment support.

## Engineering quality

The verification sequence covers TypeScript, decision logic, world geometry, integration fixtures, production builds, bundle size, documentation links and server behavior. Generated reports stay outside the tracked source tree.

## Built with

TypeScript, Preact, React-compatible TSX, CSS, WebGL2, GLSL, esbuild, Node.js 22, server-sent events, Google Cloud Run, Cloud Build and Artifact Registry. Integration tools include GitLab CI/CD, GitLab Duo flow definitions, Model Context Protocol and Terraform.
