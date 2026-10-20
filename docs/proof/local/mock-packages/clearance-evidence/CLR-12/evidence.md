# Evidence pack CLR-12

Commit `8b831d47c19029c57a11773e7490d31c4281cc6e` · 12 records · head `e34bdf162c7cccc9…` · HMAC-signed

| # | Stage | Actor | Record | Hash |
|---|---|---|---|---|
| 0 | plan | `clearance:assess` | Risk 9% (minimal); preliminary clearance autonomous | `fee1de6320` |
| 1 | secure | `clearance:gate` | No scanner findings | `64ed465d9c` |
| 2 | secure | `clearance:gate` | autonomous at risk 9% with trust 69% | `ec6409c653` |
| 3 | secure | `clearance:gate` | No scanner findings | `a2021a87d2` |
| 4 | secure | `clearance:gate` | autonomous at risk 9% with trust 69% | `5883faaebc` |
| 5 | plan | `clearance:assess` | Risk 9% (minimal); preliminary clearance autonomous | `c7da56dd9b` |
| 6 | release | `clearance:release` | Released v0.1.0 | `07de8d3ef5` |
| 7 | configure | `clearance:fly` | Deployed tower-00042-canary with no traffic | `015ef4f50b` |
| 8 | monitor | `clearance:fly` | 25% step: promote | `465f695b81` |
| 9 | monitor | `clearance:fly` | 50% step: promote | `cb6e76600b` |
| 10 | monitor | `clearance:land` | Landed: canary promoted to 100% | `6cbf131d95` |
| 11 | govern | `clearance:sci` | 0.165 gCO2e per flight | `e34bdf162c` |

## Controls evidenced

- **SOC 2 CC8.1** Changes are authorised, tested, approved and implemented (assessment, clearance, deployment)
- **SOC 2 CC7.2** System components are monitored for anomalies (canary)
- **ISO 27001:2022 A.8.32** Change management (assessment, clearance, release)
- **ISO 27001:2022 A.8.28** Secure coding (security)
- **ISO 27001:2022 A.8.29** Security testing in development and acceptance (security)
- **NIST SSDF PS.3.2** Collect and maintain provenance data for each release (release)