import { Link } from "react-router-dom";

const IDS = ["widget-42", "gadget-7", "sprocket-99"];

export function Products() {
	return (
		<main>
			<h1>Products</h1>
			<p>A list route linking into the dynamic detail route.</p>
			<ul>
				{IDS.map((id) => (
					<li key={id}>
						<Link to={`/products/${id}`}>{id}</Link>
					</li>
				))}
			</ul>
			<Link to="/">← home</Link>
		</main>
	);
}
