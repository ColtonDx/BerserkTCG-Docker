import type { JSX } from 'react';
import { CardImage } from './CardImage.js';

/**
 * A card held up close, for as long as the button is down.
 *
 * Deliberately not a dialog: nothing to dismiss, nothing to click, and it
 * never takes the pointer — the press that raised it has to keep reaching the
 * card underneath so that letting go puts it back down.
 */

interface Props {
  readonly defId: string;
}

export function Peek({ defId }: Props): JSX.Element {
  return (
    <div className="peek" aria-hidden="true">
      <CardImage defId={defId} className="peek__art" />
    </div>
  );
}
