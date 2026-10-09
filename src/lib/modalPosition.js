/**
 * Returns props for a modal overlay that always centers the modal in the
 * viewport, but adjusts the animation origin so it feels like the modal
 * "grows" from the direction of the click.
 *
 * This is the most reliable approach:
 *   - Modal is always fully visible and centered (never off-screen)
 *   - The animation origin gives visual feedback about where the click was
 */
export function calcModalPosition(position) {
  if (!position) {
    return { overlayClass: '', wrapperStyle: null, originStyle: null };
  }

  // Calculate where in the viewport the click was (as a percentage)
  const xPct = Math.round((position.x / window.innerWidth)  * 100);
  const yPct = Math.round((position.y / window.innerHeight) * 100);

  return {
    overlayClass: '',    // no special class — keep default centered flex layout
    wrapperStyle: null,  // no wrapper positioning — modal stays centered
    originStyle: {
      transformOrigin: `${xPct}% ${yPct}%`,
      animation: 'modalPopIn 0.25s ease-out',
    },
  };
}
