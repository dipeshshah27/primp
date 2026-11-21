import styles from './Card.module.css';

export interface CardProps {
  icon: string;
  title: string;
  body: string;
}

// Styling system 3 of 3: CSS module (Card.module.css). Rendered 6 times by Features.tsx.
export function Card({ icon, title, body }: CardProps) {
  return (
    <article data-label="card" className={styles.card}>
      <span data-label="card-icon" className={styles.icon}>
        {icon}
      </span>
      <h3 data-label="card-title" className={styles.title}>
        {title}
      </h3>
      <p data-label="card-body" className={styles.body}>
        {body}
      </p>
    </article>
  );
}
