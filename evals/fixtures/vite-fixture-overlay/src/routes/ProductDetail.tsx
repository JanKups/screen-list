import { Link, useParams } from "react-router-dom";

export function ProductDetail() {
	const { id } = useParams();
	return (
		<main>
			<h1>Product: {id}</h1>
			<p>
				This route renders visibly different content per <code>:id</code>. You
				are viewing product <strong>{id}</strong>.
			</p>
			<Link to="/products">← products</Link>
		</main>
	);
}
