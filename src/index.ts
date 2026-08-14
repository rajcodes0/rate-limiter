import express, { Request, Response } from 'express';

import { rateLimiter } from "./middleware/rateLimiter"

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(rateLimiter);
app.get('/', (req: Request, res: Response) => {
  res.json({ message: 'TypeScript backend is running successfully!' });
});

app.listen(PORT, () => {
  console.log(`Server is safely listening on http://localhost:${PORT}`);
});

