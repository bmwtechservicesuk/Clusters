# BMWTECH Clusters

An instrument-cluster app for BMW iDrive 7 (MGU) head units, made with Cluster Studio. It draws your
clusters on the whole 1920x720 instrument cluster through
[cluster-render](https://github.com/robertnisipeanu/idrive-apps/tree/main/native/cluster-render).
Open the app on the centre screen: every cluster shows as a card with its picture and name. Tap one to
show it, or **BMW's own** to put the stock cluster back. **All settings** has the fuel tank size, time zone
and demo data. Each cluster follows the drive mode (Comfort, Sport, Eco Pro).

## Install

1. Put this folder in a new GitHub repository (on a computer: unzip it, create an empty repo, then
   **Add file → Upload files** and drag in everything inside the folder, so `mgu-repo.json` sits at the top).
2. In the mgu Store on the car, install **cluster-render** from the source `robertnisipeanu/idrive-apps`.
3. Add your repository (`bmwtechservicesuk/clusters`) as a Store source and install **BMWTECH Clusters**. The Store builds
   the app on the head unit.
4. Open the app and tap a cluster. Under **All settings**, set **Fuel tank size** and **Time zone (clock)** for your car (a named zone,
   such as UK, changes for summer time by itself).

Before you drive with it, check that BMW's warning lights still show: start with a seat belt off and look.

## Updating

Make your changes in Cluster Studio, build the app again with a higher version number, and replace the
files in your repository. The Store offers the update.

## What's in here

| Path | |
|---|---|
| `apps/cs_bmwtech_clusters/` | the app: `app.json` (name, settings, car signals), `main.js` and `player.js` (the drawing), `designs/` (your clusters) |
| `kit/` | the MGU App Kit: the build the Store runs (`kit/tools/build.py`) and the app runtime |
| `mgu-repo.json` | tells the Store where the app is and how to build it |

Never add `oap-sdk/` or a `.mgu` file to the repository: they hold BMW's SDK.

## Licences

The MGU App Kit (`kit/`) is MIT licensed (`kit/LICENSE`), from
[f30-cluster](https://github.com/sergey-olefir/f30-cluster). `cluster_render_client.js` is MPL-2.0
(`LICENSES/MPL-2.0.txt`), from [idrive-apps](https://github.com/robertnisipeanu/idrive-apps). Drive-mode,
fuel, range, boost and outside-temperature decoding follow f30-cluster and cauliflowermossgrape's car_vitals (MIT).
`tz.js` (time zones), `vehicle_state.js` (the switch-off guard) and `shift_cue.js` (the count-in shift lights) are
from [bimmer-lab/apps](https://github.com/bimmer-lab/apps), MIT (`LICENSES/bimmer-lab-MIT.txt`); the last two are
ports of cauliflowermossgrape's Redline app, MIT. The indicator signal is the one f30-cluster's feature audit names
(CDS2 statusIndicate); its values aren't published yet, so the app logs what your car sends ("indicators: ..." in the
app's log) in case they need correcting. The digit atlases are drawn from Rajdhani, Barlow Condensed,
Orbitron and Inter, all under the SIL Open Font License 1.1.
