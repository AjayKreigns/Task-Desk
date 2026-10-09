import { createPortal } from 'react-dom';

// Renders children directly into document.body so modals stay fixed to the
// viewport instead of being trapped inside an animated (transformed) ancestor
// — any CSS `transform` on a parent turns `position: fixed` descendants into
// being positioned relative to that parent instead of the viewport.
export default function ModalPortal({ children }) {
  return createPortal(children, document.body);
}
