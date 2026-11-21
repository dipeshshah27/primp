import big from '../data/big.json';

const rows = Array.from({ length: big.rows }, (_, index) => index);

// More than 10,000 host elements, all created by this one component in a single render:
// 2,600 rows x (1 <tr> + 4 <td>) = 13,000, plus a handful around the table.
//
// React (development) stops capturing owner stacks after 10,000 elements have been created
// within a short window. Elements are created in source order here (title, back link, rows
// top to bottom, footer), so "big-title" is created first, "big-cell-name" is created 2,600
// times across the cap, and "big-footer" is created after every row.
export function BigPage() {
  return (
    <div className="big-page">
      <h1 data-label="big-title" className="text-2xl font-semibold tracking-tight">
        Big list: {big.rows} rows
      </h1>
      <p className="big-page__back">
        <a href="/">Back to home</a>
      </p>
      <table className="big-table">
        <tbody>
          {rows.map((index) => (
            <tr key={index}>
              <td data-label="big-cell-name">Item {index + 1}</td>
              <td>{(index * 37) % 1000}</td>
              <td>{index % 3 === 0 ? 'active' : 'idle'}</td>
              <td>row-{index}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p data-label="big-footer" className="big-page__footer">
        End of list.
      </p>
    </div>
  );
}
