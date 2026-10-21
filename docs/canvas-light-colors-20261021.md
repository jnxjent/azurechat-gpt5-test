# Canvas light colors (2026-10-21)

- Light mode follows the supplied palette. Single-series bars use a different color per category, cycling after nine colors. Multiple series retain one color per series, matching the legend.
- Dark mode keeps the existing colors. The resolved next-themes theme also supports system light/dark preferences.
- Colors are actual SVG attributes and remain in the exported chart.
- No Salesforce access-control, connection, or storage-format changes are included in this deployment.
- Regression tests check palette order, cycling, multiple series and unchanged dark-mode bars.
