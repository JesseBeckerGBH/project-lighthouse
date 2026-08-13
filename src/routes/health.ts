import { Router } from 'express';
import { ok } from '../errors';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json(ok({ status: 'ok', timestamp: new Date().toISOString() }));
});
