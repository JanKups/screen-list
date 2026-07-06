import { Link } from "react-router-dom";

export function Home() {
	return (
		<main>
			<h1>vite-fixture</h1>
			<p>
				Reproducible Vite + react-router SPA fixture for screenshot-review-web
				evals. Routes are defined in code (<code>createBrowserRouter</code>),
				not on the filesystem.
			</p>
			<ul>
				<li>
					<Link to="/about">/about</Link>
				</li>
				<li>
					<Link to="/products">/products</Link>
				</li>
				<li>
					<Link to="/products/widget-42">/products/widget-42</Link> (dynamic
					route)
				</li>
				<li>
					<Link to="/settings">/settings</Link>
				</li>
			</ul>
		</main>
	);
}
