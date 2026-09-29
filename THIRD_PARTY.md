# Third-party components

| Component | Used for | License |
| --- | --- | --- |
| [Electron for Content Security](https://github.com/castlabs/electron-releases) (castlabs) | app runtime, with Widevine | MIT (Electron) + castlabs terms |
| [Leaflet](https://github.com/Leaflet/Leaflet) | route map | BSD-2-Clause |
| [yauzl](https://github.com/thejoshwolfe/yauzl) | unpacking extension packages | MIT |
| [Lucide](https://lucide.dev/) | icons (`ui/icons.js`, generated from `lucide-static`) | ISC |
| Instrument Sans, Instrument Serif | interface fonts (`assets/fonts`) | SIL Open Font License 1.1 |
| JetBrains Mono | numbers and data (`assets/fonts`) | SIL Open Font License 1.1 |

Online services used at runtime:

- Maps: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, tiles from openstreetmap.org.
- Geocoding: [Nominatim](https://operations.osmfoundation.org/policies/nominatim/), at most one request per second.
- Routing: [OSRM](https://project-osrm.org/) on routing.openstreetmap.de (FOSSGIS).
- Weather: [Open-Meteo](https://open-meteo.com/).
- Trains: ViaggiaTreno (Trenitalia).
