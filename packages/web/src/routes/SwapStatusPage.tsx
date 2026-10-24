import { useParams } from 'react-router';
import { PlaceholderPage } from '../components/PlaceholderPage';

export function SwapStatusPage() {
  const { orderId } = useParams<{ orderId: string }>();

  return (
    <PlaceholderPage
      eyebrow="Swap status"
      title="Follow the ferry"
      description="The live timeline, block countdowns and claim or refund actions will live here."
      detail={orderId ? `Order ${orderId}` : 'No order id in the URL'}
    />
  );
}
