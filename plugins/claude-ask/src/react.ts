/// `react`, as the diff tab's page lends it (see the differ's lib/extensions.ts): the
/// boxes render inside its tree, and a second copy of React can't draw there.
const React = window.termiauDiffer!.React;
export default React;
export const { useEffect, useMemo, useState, useSyncExternalStore, useRef, useCallback } = React;
