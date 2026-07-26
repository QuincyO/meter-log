# Offline road map packs

Each `*.pack` here is one district's drivable road network **and its addresses**, in the
compact binary `js/roadgraph.js` reads. The phone downloads one from Settings ▸ **Offline
road map** and then measures real driving distance *and geocodes addresses* on-device — no
signal, no Google spend.

`index.json` is the published catalogue the picker reads. Both the packs and the catalogue
are written by the build tool; don't hand-edit either.

The easy way is the planner's **Districts** panel — draw the area on the map, Build,
Publish. It needs `node tools/roadpack-server.mjs --data D:\osrm` running on the planning
PC. By hand:

    node tools/build-roadpack.mjs \
      --in   D:/osrm/district-roads.geojsonseq \
      --addr D:/osrm/district-addr.geojsonseq \
      --id kawartha --name "Kawartha Lakes" \
      --bbox -79.4,44.2,-78.0,45.0

See DEPLOY.md §"Offline road maps for the phone" for the `osmium` commands that turn the
Ontario `.pbf` you already downloaded for OSRM into those inputs. `--addr` is optional —
without it the pack routes but doesn't geocode.

**These files are served by GitHub Pages like everything else in the repo**, which is what
makes the download a plain `fetch('maps/<id>.pack')`. Two consequences worth knowing:

- Every rebuild adds a new multi-megabyte blob to git history, permanently. Rebuild when the
  roads actually change, not on a schedule.
- They are deliberately **not** in `sw.js`'s `SHELL`. The shell is re-fetched wholesale by
  ⟳ Force update from GitHub, and packs would turn a routine app update into a many-megabyte
  download on boat signal. They live in IndexedDB instead and survive app refreshes.
