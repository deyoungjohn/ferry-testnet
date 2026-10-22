import { useParams } from 'react-router';
import { PlaceholderPage } from '../components/PlaceholderPage';

export function PayLinkPage() {
  const { linkId } = useParams<{ linkId: string }>();

  return (
    <PlaceholderPage
      eyebrow="Pay link"
      title="Get paid in dollars on Bitcoin Cash"
      description="A pay link lets someone pay you in PUSD on Bitcoin Cash, even if they hold USDC or USDT on another chain."
      detail={linkId ? `Link ${linkId}` : 'No link id in the URL'}
    />
  );
}
