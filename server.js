require('dotenv').config(); // Load environment variables from .env
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const path = require('path');

// This tells Express to serve all files in your project folder (html, js, css)
app.use(express.static(path.join(__dirname))); 

// This ensures that visiting the root URL sends your index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Middleware
app.use(cors());
app.use(express.json());

// 1. Connect to MongoDB
// Replace the URI in your .env file with your local or Atlas string
const DB_URI = process.env.MONGO_URI;

mongoose.connect(DB_URI)
    .then(() => console.log('🚀 Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// 2. Define the Project Schema
const projectSchema = new mongoose.Schema({
    projectId: { type: String, required: true, unique: true },
    name: { type: String, default: "Untitled Project" },
    vfs: { type: Object, required: true },
    lastUpdated: { type: Date, default: Date.now }
});

const Project = mongoose.model('Project', projectSchema);

// 3. API Routes

// GET: Fetch a project by ID
app.get('/api/projects/:id', async (req, res) => {
    try {
        const project = await Project.findOne({ projectId: req.params.id });
        
        if (project) {
            res.json(project);
        } else {
            // If it's the guest account and doesn't exist yet, return a default
            if (req.params.id === 'guest-123') {
                return res.json({
                    projectId: 'guest-123',
                    vfs: { "main.psc": "// Start coding here...\nOUTPUT \"Hello World\"" }
                });
            }
            res.status(404).json({ error: "Project not found" });
        }
    } catch (err) {
        res.status(500).json({ error: "Server error fetching project" });
    }
});

// POST: Save/Update a project
app.post('/api/projects/:id', async (req, res) => {
    const { vfs, name } = req.body;
    
    try {
        // findOneAndUpdate with 'upsert: true' creates the doc if it doesn't exist
        const updatedProject = await Project.findOneAndUpdate(
            { projectId: req.params.id },
            { 
                vfs: vfs, 
                name: name || "My First Project",
                lastUpdated: Date.now() 
            },
            { upsert: true, new: true }
        );

        console.log(`Project ${req.params.id} synced to MongoDB.`);
        res.json({ success: true, project: updatedProject });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error saving project" });
    }
});

app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
