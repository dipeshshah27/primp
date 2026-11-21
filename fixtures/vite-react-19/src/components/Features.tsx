import cards from '../data/cards.json';
import { Card } from './Card';

// Renders <Card> once per entry of cards.json (6 entries), so every label inside Card.tsx
// appears 6 times in the DOM.
export function Features() {
  return (
    <section data-label="features" id="features" className="py-10">
      <h2 data-label="features-title" className="text-2xl font-semibold tracking-tight">
        What it does
      </h2>
      <div data-label="card-grid" className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <Card key={card.id} icon={card.icon} title={card.title} body={card.body} />
        ))}
      </div>
    </section>
  );
}
