import { FeatureCards } from '../components/FeatureCards';
import { Faq } from '../components/Faq';
import { Hero } from '../components/Hero';
import { HowItWorks } from '../components/HowItWorks';
import { PegCards } from '../components/PegCards';
import { RecentSwaps } from '../components/RecentSwaps';
import { StatsRow } from '../components/StatsRow';
import { SwapCard } from '../components/SwapCard';
import { useHomeData } from '../lib/stats/useHomeData';

export function HomePage() {
  const data = useHomeData();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
      <section className="grid items-center gap-12 pt-12 sm:pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pt-24">
        <Hero />
        <div className="swap-stage w-full max-w-[30rem] justify-self-center lg:justify-self-end">
          <span aria-hidden="true" className="horizon-arc" />
          <SwapCard />
        </div>
      </section>
      <StatsRow resource={data.stats} />
      <FeatureCards stats={data.stats} />
      <RecentSwaps resource={data.recentSwaps} />
      <PegCards resource={data.pegs} />
      <HowItWorks />
      <Faq />
    </div>
  );
}
