import { useTender } from './tenderContext';

/**
 * Slot between the tender header and the tabs, rendered on every tab by TenderLayout.
 * OWNER (tenders): return <Banner tone="orange" …/> / <Banner tone="red" …/> items here for
 * compressed mode (R8), guarantee validity (R16), expired linked documents (R15), late G0 (R7) etc.
 * Return a fragment of Banners (or null): the wrapper collapses when empty.
 */
export function TenderBanners() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tender } = useTender();
  return null;
}
