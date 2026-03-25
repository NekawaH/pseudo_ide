const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
    projectId: { type: String, required: true, unique: true }, // Your Guest ID
    projectName: { type: String, default: "Untitled Project" },
    vfs: { type: Object, required: true }, // Stores the entire window.vfs object
    lastSaved: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Project', projectSchema);
