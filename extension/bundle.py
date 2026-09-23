import os
import re

def convert_to_classic(directory):
    files_to_process = [
        "db/indexeddb.js",
        "ml/tfidf.js",
        "ml/clustering.js",
        "ml/difficulty.js",
        "ml/mode-classifier.js",
        "ml/memory.js",
        "providers/gemini.js",
        "providers/groq.js",
        "providers/openai.js",
        "prompts.js",
        "router.js",
        "service-worker.js"
    ]

    out_file = "service-worker-bundle.js"
    
    with open(os.path.join(directory, out_file), "w", encoding="utf-8") as out:
        out.write("// Auto-bundled background script\n")
        
        for file in files_to_process:
            path = os.path.join(directory, file)
            if not os.path.exists(path):
                continue
                
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
                
            # Remove imports
            content = re.sub(r'import\s+.*?from\s+[\'"].*?[\'"];?', '', content, flags=re.DOTALL)
            
            # Remove exports
            content = re.sub(r'export\s+default\s+', '', content)
            content = re.sub(r'export\s+(const|let|var|function|class|async\s+function)\s+', r'\1 ', content)
            content = re.sub(r'export\s+\{.*?\};?', '', content, flags=re.DOTALL)
            
            out.write(f"// --- {file} ---\n")
            out.write(content)
            out.write("\n\n")

if __name__ == "__main__":
    convert_to_classic(r"c:\Users\codilar\bubble-ai\extension\background")
