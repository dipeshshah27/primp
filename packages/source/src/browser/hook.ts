/**
 * The synchronous part: must be the first script in <head>, before React loads.
 *
 * `bippy/install-hook-only` defines `__REACT_DEVTOOLS_GLOBAL_HOOK__` if nobody has, in a way
 * that survives React Refresh and the real React DevTools replacing it later. React only
 * registers its renderer with a hook that exists when react-dom first runs, so this cannot
 * be loaded lazily. It is 3.4 kB minified (1.6 kB gzipped) and reads nothing from the page.
 *
 * Everything else in this package can load whenever the probe loads: finding a fiber needs
 * only the DOM node, and the hook is used for the renderer's version and build type.
 *
 * Source lookup itself does not depend on this hook. Measured in spike S2 with no reglet hook
 * injected at all: 51 of 51 labels on the Vite fixture and 46 of 46 on the Next fixture's home
 * page still resolved at level exact (React Refresh and Next install a hook of their own, with
 * an empty renderer list). What is lost without it is `version` / `bundleType` in the evidence,
 * and with them the "production build" note.
 */
import 'bippy/install-hook-only'
