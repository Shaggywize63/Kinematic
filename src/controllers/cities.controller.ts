import { Request, Response } from 'express';
import City from '../models/city.model';

export const citiesCtrl = {
  // GET all cities
  async list(req: Request, res: Response) {
    try {
      const cities = await City.find().sort({ createdAt: -1 });
      return res.json({ data: cities });
    } catch (err) {
      return res.status(500).json({ message: 'Failed to fetch cities' });
    }
  },

  // GET one city
  async getOne(req: Request, res: Response) {
    try {
      const city = await City.findById(req.params.id);
      if (!city) {
        return res.status(404).json({ message: 'City not found' });
      }
      return res.json({ data: city });
    } catch (err) {
      return res.status(500).json({ message: 'Failed to fetch city' });
    }
  },

  // CREATE city
  async create(req: Request, res: Response) {
    try {
      const { name, state, country } = req.body;

      if (!name) {
        return res.status(400).json({ message: 'City name is required' });
      }

      const city = await City.create({
        name,
        state,
        country,
        status: 'active'
      });

      return res.status(201).json({ data: city });
    } catch (err) {
      return res.status(500).json({ message: 'Failed to create city' });
    }
  },

  // UPDATE city
  async update(req: Request, res: Response) {
    try {
      const city = await City.findByIdAndUpdate(
        req.params.id,
        req.body,
        { new: true }
      );

      if (!city) {
        return res.status(404).json({ message: 'City not found' });
      }

      return res.json({ data: city });
    } catch (err) {
      return res.status(500).json({ message: 'Failed to update city' });
    }
  },

  // DELETE city
  async remove(req: Request, res: Response) {
    try {
      const city = await City.findByIdAndDelete(req.params.id);

      if (!city) {
        return res.status(404).json({ message: 'City not found' });
      }

      return res.json({ message: 'City deleted successfully' });
    } catch (err) {
      return res.status(500).json({ message: 'Failed to delete city' });
    }
  }
};
