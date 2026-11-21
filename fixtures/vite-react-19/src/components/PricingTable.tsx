import plans from '../data/plans.json';

// Styled entirely by plain CSS (site.css): the plan grid switches from one column to three at
// @media (min-width: 768px). The plan cards are rendered inline by plans.map (3 entries), so
// every label inside that callback appears 3 times in the DOM.
export function PricingTable() {
  return (
    <section data-label="pricing" id="pricing" className="pricing">
      <h2 data-label="pricing-title" className="pricing__title">
        Pricing
      </h2>
      <p data-label="pricing-lead" className="pricing__lead">
        Start on the free plan. Upgrade when the whole team wants in.
      </p>
      <div data-label="pricing-grid" className="pricing-grid">
        {plans.map((plan) => (
          <div data-label="plan" key={plan.id} className={plan.featured ? 'plan plan--featured' : 'plan'}>
            <h3 data-label="plan-name" className="plan__name">
              {plan.name}
            </h3>
            <p data-label="plan-price" className="plan__price">
              {plan.price}
              <span className="plan__period">{plan.period}</span>
            </p>
            <ul data-label="plan-features" className="plan__features">
              {plan.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            <button data-label="plan-cta" type="button" className="plan__cta">
              Choose {plan.name}
            </button>
          </div>
        ))}
      </div>
      <table data-label="pricing-compare" className="compare">
        <caption className="compare__caption">Limits by plan</caption>
        <thead>
          <tr data-label="pricing-compare-head">
            <th scope="col">Limit</th>
            <th scope="col">Starter</th>
            <th scope="col">Team</th>
            <th scope="col">Scale</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Projects</th>
            <td>1</td>
            <td>Unlimited</td>
            <td>Unlimited</td>
          </tr>
          <tr>
            <th scope="row">History</th>
            <td>7 days</td>
            <td>90 days</td>
            <td>Unlimited</td>
          </tr>
          <tr data-label="pricing-compare-support">
            <th scope="row">Support</th>
            <td>Community</td>
            <td>Email</td>
            <td>Priority</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
