# Evidence pack CLR-12

Commit `bbfb1ded212701ec92e6f9878f13a83d224d8bb9` · 12 records · head `c4de7ba7757e4ee9…` · HMAC-signed

| # | Stage | Actor | Record | Hash |
|---|---|---|---|---|
| 0 | plan | `clearance:assess` | Risk 9% (minimal); preliminary clearance autonomous | `09cf9d96c6` |
| 1 | secure | `clearance:gate` | No scanner findings | `b75e13cad8` |
| 2 | secure | `clearance:gate` | autonomous at risk 9% with trust 69% | `72008524b0` |
| 3 | secure | `clearance:gate` | No scanner findings | `2c633146c4` |
| 4 | secure | `clearance:gate` | autonomous at risk 9% with trust 69% | `2738718056` |
| 5 | plan | `clearance:assess` | Risk 9% (minimal); preliminary clearance autonomous | `bc48a6d335` |
| 6 | release | `clearance:release` | Released v0.1.0 | `bc524d4d0e` |
| 7 | configure | `clearance:fly` | Deployed tower-00042-canary with no traffic | `040a841415` |
| 8 | monitor | `clearance:fly` | 25% step: promote | `312294ecc4` |
| 9 | monitor | `clearance:fly` | 50% step: promote | `43398da111` |
| 10 | monitor | `clearance:land` | Landed: canary promoted to 100% | `95ffa3fe27` |
| 11 | govern | `clearance:sci` | 0.165 gCO2e per flight | `c4de7ba775` |

## Controls evidenced

- **SOC 2 CC8.1** Changes are authorised, tested, approved and implemented (assessment, clearance, deployment)
- **SOC 2 CC7.2** System components are monitored for anomalies (canary)
- **ISO 27001:2022 A.8.32** Change management (assessment, clearance, release)
- **ISO 27001:2022 A.8.28** Secure coding (security)
- **ISO 27001:2022 A.8.29** Security testing in development and acceptance (security)
- **NIST SSDF PS.3.2** Collect and maintain provenance data for each release (release)