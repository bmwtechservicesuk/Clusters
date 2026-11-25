'use strict';
/**
 * A Cluster Studio app: the clusters designed in Cluster Studio, drawn on the whole 1920x720 instrument cluster
 * through cluster-render. The centre screen picks one, or "Off" for BMW's own cluster.
 *
 * Node 8 (the head unit's 8.16.2): no optional chaining, no ??.
 */
const mgu = require('./kit/mgu');
const Player = require('./player');
const Page = require('./page');

mgu.run({
    start(ctx) {
        let player;
        try {
            player = new Player(ctx);
            player.start();
        } catch (e) {
            // stay up with nothing drawn: an exit here counts as a crash on the car
            ctx.log.error('Cluster failed to start: ' + (e && e.stack || e));
            try { ctx.ui.text('STATUS', 'Could not start: ' + (e && e.message || e)); } catch (e2) { /* no screen yet */ }
            return;
        }
        // the centre screen: a failure here leaves the cluster drawing (and the kit's own settings sheet working)
        try { new Page(ctx, player).start(); } catch (e) { ctx.log.error('page failed to start: ' + (e && e.stack || e)); }
        process.on('exit', () => { try { player.stop(); } catch (e) { /* exiting anyway */ } });
    },
});
