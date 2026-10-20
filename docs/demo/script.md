# Clearance — demo guide

[Open the live demo](https://clearance-tower-30123867341.northamerica-northeast1.run.app/)

The hosted demo uses simulated delivery traffic with the implemented decision engine. Flight identifiers and values update as the simulation runs.

## Suggested tour — 2:40

| Time | Show | Explain |
|---|---|---|
| 0:00–0:15 | Home hero and Open the tower | Clearance brings delivery progress and decision reasons into one shared view. |
| 0:15–0:35 | Flight-path diagram and scroll chapters | Every change is a flight approaching production through nine gates. Visitors can follow the story or enter directly. |
| 0:35–0:58 | Airspace search and Holding filter | Find a change by identifier, title or pilot, then narrow the view to traffic needing attention. |
| 0:58–1:20 | Flight inspector | Read the clearance explanation, risk signals and stage history together. |
| 1:20–1:38 | Airport and Riverside cameras; expand the scene | Explore the procedural airport, river and city. Expand controls give more room to either the world or the board. |
| 1:38–2:05 | Governor presets and editable inputs | Change files, trust or error budget and see the what-if decision update. Production policy remains unchanged. |
| 2:05–2:22 | Trust ledger and Carbon | Explore the track records behind decisions and the modelled footprint of delivery work. |
| 2:22–2:32 | Keyboard focus and responsive panels | Show labelled controls, visible focus and the layout at a narrow width. The interface also supports reduced-motion preferences. |
| 2:32–2:40 | Return to Airspace | Close with the live demo and source repository. |

## Interaction checklist

1. Follow a numbered stage link on the landing page.
2. Open Airspace and press `/` to focus search.
3. Search for a visible flight and open its inspector.
4. Return to the flight board and try the Holding filter.
5. Switch between Approach, Airport, Riverside and Tower cameras.
6. Select a flight to enable Follow.
7. Expand and restore the flight board or airspace.
8. Open Governor, load a preset and change one input.
9. Visit Trust ledger and Carbon through the console navigation.

Choose a flight with the information you want to demonstrate and keep its current values readable. The [design case study](../design-case-study.md) explains the interaction choices; [architecture](../architecture.md) covers the implementation.
