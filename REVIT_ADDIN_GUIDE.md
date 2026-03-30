# ClashControl Connector for Revit — Build Guide

> **Purpose**: This document is a self-contained specification for building a Revit add-in that connects to [ClashControl](https://github.com/clashcontrol-io/clash-control) via WebSocket. Drop this file into a Claude Code session to build the entire plugin.

## What It Does

A Revit plugin that:
1. **Runs a WebSocket server** on `localhost:19780` inside Revit
2. **Exports geometry + properties** of the active model to ClashControl (browser app) over WebSocket
3. **Pushes live updates** when the Revit model changes (DocumentChanged event)
4. **Receives clash results** from ClashControl and highlights clashing elements in Revit
5. **Highlights elements on selection** — when the user clicks a clash in ClashControl, the corresponding elements light up in Revit

No cloud server, no internet required. Everything runs on the user's local machine.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                 User's PC                   │
│                                             │
│  ┌──────────────┐   WebSocket    ┌────────────────┐
│  │   Revit      │  localhost     │   Browser       │
│  │   + Plugin   │◄─────────────►│   ClashControl  │
│  │              │   :19780      │                  │
│  └──────────────┘               └────────────────┘
│                                             │
└─────────────────────────────────────────────┘
```

- The plugin starts an HTTP listener on `localhost:19780` that accepts WebSocket upgrade requests
- ClashControl (in the browser) connects to `ws://localhost:19780`
- The connection is bidirectional: the plugin sends geometry/properties, the browser sends commands and clash data
- All Revit API calls happen on Revit's main thread via `ExternalEvent`

---

## Project Structure

```
ClashControlConnector/
├── ClashControlConnector.sln
├── ClashControlConnector/
│   ├── ClashControlConnector.csproj          — .NET Framework 4.8 (Revit 2024) or .NET 8 (Revit 2025+)
│   ├── ClashControlConnector.addin           — Revit add-in manifest
│   ├── App.cs                                — IExternalApplication entry point
│   ├── Commands/
│   │   └── ToggleCommand.cs                  — Ribbon button to start/stop connector
│   ├── Core/
│   │   ├── WebSocketServer.cs                — HTTP listener + WebSocket server on localhost
│   │   ├── GeometryExporter.cs               — Extracts triangulated meshes from Revit elements
│   │   ├── PropertyExporter.cs               — Extracts parameters, levels, materials, types
│   │   ├── RelationshipExporter.cs           — Builds host/void/fill relatedPairs
│   │   └── GlobalIdEncoder.cs                — Converts Revit GUID to 22-char IFC GlobalId
│   ├── Protocol/
│   │   ├── Messages.cs                       — Message types + JSON serialization
│   │   └── ElementData.cs                    — Element data transfer object
│   └── Resources/
│       └── icon.png                          — 32x32 ribbon icon
```

---

## Dependencies

### NuGet Packages
- `Newtonsoft.Json` 13.x — JSON serialization
- No WebSocket NuGet needed — use built-in `System.Net.WebSockets` + `System.Net.HttpListener`

### Revit API References (do NOT Copy Local)
- `RevitAPI.dll` — from Revit install directory (e.g., `C:\Program Files\Autodesk\Revit 2024\`)
- `RevitAPIUI.dll` — same directory
- Set **Copy Local = false** for both

### Target Framework
- Revit 2022–2024: `.NET Framework 4.8`
- Revit 2025+: `.NET 8` (net8.0-windows)

---

## Add-in Manifest

File: `ClashControlConnector.addin`

```xml
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>ClashControl Connector</Name>
    <Assembly>ClashControlConnector.dll</Assembly>
    <FullClassName>ClashControlConnector.App</FullClassName>
    <AddInId>C1A5C0D1-CC01-4F7A-B2E3-901234567890</AddInId>
    <VendorId>ClashControl</VendorId>
    <VendorDescription>ClashControl — Free IFC Clash Detection</VendorDescription>
  </AddIn>
</RevitAddIns>
```

### Installation Path
Copy `.addin` + `ClashControlConnector.dll` + `Newtonsoft.Json.dll` to:
- Revit 2024: `%APPDATA%\Autodesk\Revit\Addins\2024\`
- Revit 2025: `%APPDATA%\Autodesk\Revit\Addins\2025\`

---

## Thread Safety — CRITICAL

Revit's API is **single-threaded**. The WebSocket server runs on a background thread. You MUST marshal all Revit API calls back to the main thread.

### Pattern: ExternalEvent + ConcurrentQueue

```csharp
public class RevitCommandHandler : IExternalEventHandler
{
    private static readonly ConcurrentQueue<Action<UIApplication>> _queue
        = new ConcurrentQueue<Action<UIApplication>>();

    public static ExternalEvent Event { get; set; }

    public static void Enqueue(Action<UIApplication> action)
    {
        _queue.Enqueue(action);
        Event?.Raise();
    }

    public void Execute(UIApplication app)
    {
        while (_queue.TryDequeue(out var action))
        {
            try { action(app); }
            catch (Exception ex) { Debug.WriteLine($"[CC] Error: {ex.Message}"); }
        }
    }

    public string GetName() => "ClashControlCommandHandler";
}
```

**Rule**: When a WebSocket message arrives on a background thread, enqueue the work and call `Event.Raise()`. Revit will call `Execute()` on its main thread.

---

## Message Protocol

All messages are JSON objects with a `type` field. Geometry data is base64-encoded binary.

### Browser → Plugin

#### `ping` — Keepalive
```json
{"type":"ping"}
```
Response: `{"type":"pong"}`

#### `export` — Request model export
```json
{"type":"export","categories":["all"]}
```
Or filtered:
```json
{"type":"export","categories":["Walls","Doors","Floors"]}
```

#### `highlight` — Highlight elements in Revit
```json
{"type":"highlight","globalIds":["0K7w7jYlXCpOJN0oo5MIAN","3Ax9mWqLz1B0OvE3pQdT7k"]}
```
The plugin should find these elements and color them red using `OverrideGraphicSettings` in the active view, and optionally select them via `uidoc.Selection.SetElementIds()`.

#### `push-clashes` — Clash/issue data from ClashControl
```json
{
  "type":"push-clashes",
  "clashes":[
    {
      "id":"ABC123",
      "status":"open",
      "priority":"high",
      "type":"hard",
      "point":{"x":1.2,"y":3.4,"z":5.6},
      "elementA":{"globalId":"...","name":"Basic Wall","ifcType":"IfcWall","revitId":123456},
      "elementB":{"globalId":"...","name":"Round Duct","ifcType":"IfcDuctSegment","revitId":789012}
    }
  ],
  "issues":[
    {
      "id":"ISS001",
      "title":"Duct through beam",
      "status":"open",
      "priority":"critical",
      "description":"Duct penetrates structural beam without sleeve",
      "elementIds":[{"globalId":"...","name":"...","revitId":456}]
    }
  ]
}
```

The plugin should:
1. Color clashing elements using `OverrideGraphicSettings` (red for hard clashes, orange for clearance)
2. Optionally place marker family instances at clash `point` coordinates
3. Write shared parameters on elements: `CC_ClashID`, `CC_Status`, `CC_Priority`
4. Optionally create a filtered 3D view showing only clashing elements

**Coordinate conversion for `point`**: ClashControl uses Y-up meters. Convert back to Revit:
- `x_revit = x / 0.3048`
- `y_revit = -z / 0.3048`
- `z_revit = y / 0.3048`

### Plugin → Browser

#### `pong` — Keepalive response
```json
{"type":"pong"}
```

#### `status` — Connection status
```json
{"type":"status","connected":true,"documentName":"MyProject.rvt"}
```
Send this immediately after WebSocket connection is established.

#### `model-start` — Begin model export
```json
{"type":"model-start","name":"MyProject.rvt","elementCount":1234}
```

#### `element-batch` — Batch of elements (50–100 per message)
```json
{
  "type":"element-batch",
  "elements":[
    {
      "globalId":"0K7w7jYlXCpOJN0oo5MIAN",
      "expressId":1,
      "category":"IfcWall",
      "name":"Basic Wall: Generic - 200mm:123456",
      "level":"Level 1",
      "type":"Generic - 200mm",
      "revitId":123456,
      "materials":["Concrete","Plaster"],
      "parameters":{
        "Constraints":{"Base Constraint":"Level 1","Top Constraint":"Up to level: Level 2"},
        "Dimensions":{"Length":5000.0,"Area":15.0,"Volume":3.0},
        "Identity Data":{"Type Name":"Generic - 200mm"}
      },
      "hostId":null,
      "hostRelationships":["3Ax9mWqLz1B0OvE3pQdT7k"],
      "geometry":{
        "positions":"<base64 Float32Array — x,y,z vertex triplets>",
        "indices":"<base64 Uint32Array — triangle index triplets>",
        "normals":"<base64 Float32Array — nx,ny,nz per vertex>"
      }
    }
  ]
}
```

#### `model-end` — Export complete
```json
{
  "type":"model-end",
  "storeys":["Level 1","Level 2","Roof"],
  "storeyData":[
    {"name":"Level 1","elevation":0.0},
    {"name":"Level 2","elevation":3000.0}
  ],
  "relatedPairs":{
    "globalIdA:globalIdB":true
  }
}
```

#### `element-update` — Live model change
```json
{"type":"element-update","action":"modified","elements":[...same shape as element-batch...]}
```
```json
{"type":"element-update","action":"deleted","globalIds":["0K7w..."]}
```

#### `error` — Error message
```json
{"type":"error","message":"No document open in Revit"}
```

---

## Geometry Extraction

### Overview
For each Revit element, extract triangulated mesh data (vertices + indices + normals) and encode as base64 binary arrays.

### Coordinate Conversion — CRITICAL
Revit uses **feet, Z-up**. ClashControl uses **meters, Y-up**.

```csharp
// Revit XYZ → ClashControl (meters, Y-up)
float x_out = (float)(point.X * 0.3048);   // feet → meters
float y_out = (float)(point.Z * 0.3048);   // Revit Z → ClashControl Y (up)
float z_out = (float)(-point.Y * 0.3048);  // Revit Y → ClashControl -Z (into screen)
```

Same transform applies to normals (but without the 0.3048 scale — normals are unit vectors):
```csharp
float nx_out = (float)normal.X;
float ny_out = (float)normal.Z;
float nz_out = (float)(-normal.Y);
```

### Extraction Algorithm

```csharp
public static ElementGeometry ExtractGeometry(Element element)
{
    var positions = new List<float>();
    var indices = new List<uint>();
    var normals = new List<float>();

    var options = new Options
    {
        ComputeReferences = true,
        DetailLevel = ViewDetailLevel.Fine
    };

    var geomElement = element.get_Geometry(options);
    if (geomElement == null) return null;

    uint vertexOffset = 0;
    ProcessGeometry(geomElement, Transform.Identity, positions, indices, normals, ref vertexOffset);

    if (positions.Count == 0) return null;

    return new ElementGeometry
    {
        Positions = Convert.ToBase64String(FloatListToBytes(positions)),
        Indices = Convert.ToBase64String(UIntListToBytes(indices)),
        Normals = Convert.ToBase64String(FloatListToBytes(normals))
    };
}

private static void ProcessGeometry(GeometryElement geomElement, Transform transform,
    List<float> positions, List<uint> indices, List<float> normals, ref uint vertexOffset)
{
    foreach (var geomObj in geomElement)
    {
        switch (geomObj)
        {
            case Solid solid:
                if (solid.Volume > 0)
                    ProcessSolid(solid, transform, positions, indices, normals, ref vertexOffset);
                break;

            case GeometryInstance instance:
                var instanceGeom = instance.GetInstanceGeometry();
                // GetInstanceGeometry() already applies the instance transform
                if (instanceGeom != null)
                    ProcessGeometry(instanceGeom, Transform.Identity, positions, indices, normals, ref vertexOffset);
                break;
        }
    }
}

private static void ProcessSolid(Solid solid, Transform transform,
    List<float> positions, List<uint> indices, List<float> normals, ref uint vertexOffset)
{
    foreach (Face face in solid.Faces)
    {
        Mesh mesh = face.Triangulate();
        if (mesh == null) continue;

        int meshVertCount = mesh.Vertices.Count;

        // Compute face normal (use first triangle's normal for flat faces)
        XYZ faceNormal = face.ComputeNormal(new UV(0.5, 0.5));
        XYZ transformedNormal = transform.IsIdentity ? faceNormal : transform.OfVector(faceNormal);

        // Normals: Revit Z-up → Y-up
        float nx = (float)transformedNormal.X;
        float ny = (float)transformedNormal.Z;
        float nz = (float)(-transformedNormal.Y);

        // Add vertices
        for (int i = 0; i < meshVertCount; i++)
        {
            XYZ pt = mesh.Vertices[i];
            XYZ transformed = transform.IsIdentity ? pt : transform.OfPoint(pt);

            // Convert: feet Z-up → meters Y-up
            positions.Add((float)(transformed.X * 0.3048));
            positions.Add((float)(transformed.Z * 0.3048));
            positions.Add((float)(-transformed.Y * 0.3048));

            // Per-vertex normals (use face normal for all vertices of this face)
            normals.Add(nx);
            normals.Add(ny);
            normals.Add(nz);
        }

        // Add triangle indices
        for (int i = 0; i < mesh.NumTriangles; i++)
        {
            MeshTriangle tri = mesh.get_Triangle(i);
            indices.Add(vertexOffset + (uint)tri.get_Index(0));
            indices.Add(vertexOffset + (uint)tri.get_Index(1));
            indices.Add(vertexOffset + (uint)tri.get_Index(2));
        }

        vertexOffset += (uint)meshVertCount;
    }
}
```

### Base64 Encoding Helpers

```csharp
private static byte[] FloatListToBytes(List<float> list)
{
    var bytes = new byte[list.Count * 4];
    Buffer.BlockCopy(list.ToArray(), 0, bytes, 0, bytes.Length);
    return bytes;
}

private static byte[] UIntListToBytes(List<uint> list)
{
    var bytes = new byte[list.Count * 4];
    Buffer.BlockCopy(list.ToArray(), 0, bytes, 0, bytes.Length);
    return bytes;
}
```

---

## Property Extraction

### IFC GlobalId Generation

ClashControl uses 22-character IFC GlobalIds as join keys. Convert Revit's GUID:

```csharp
public static class GlobalIdEncoder
{
    private static readonly char[] Base64Chars =
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$".ToCharArray();

    public static string ToIfcGlobalId(Guid guid)
    {
        var bytes = guid.ToByteArray();

        // Rearrange bytes to match IFC encoding order
        var num = new byte[16];
        num[0] = bytes[3]; num[1] = bytes[2]; num[2] = bytes[1]; num[3] = bytes[0];
        num[4] = bytes[5]; num[5] = bytes[4];
        num[6] = bytes[7]; num[7] = bytes[6];
        Array.Copy(bytes, 8, num, 8, 8);

        var result = new char[22];
        int offset = 0;

        // Encode 16 bytes (128 bits) into 22 base64 characters (132 bits, 4 padding)
        result[offset++] = Base64Chars[(num[0] & 0xFC) >> 2];
        result[offset++] = Base64Chars[((num[0] & 0x03) << 4) | ((num[1] & 0xF0) >> 4)];

        for (int i = 1; i < 15; i += 3)
        {
            if (i + 2 < 16)
            {
                result[offset++] = Base64Chars[((num[i] & 0x0F) << 2) | ((num[i + 1] & 0xC0) >> 6)];
                result[offset++] = Base64Chars[num[i + 1] & 0x3F];
                result[offset++] = Base64Chars[(num[i + 2] & 0xFC) >> 2];
                if (i + 3 < 16)
                    result[offset++] = Base64Chars[((num[i + 2] & 0x03) << 4) | ((num[i + 3] & 0xF0) >> 4)];
                else
                    result[offset++] = Base64Chars[(num[i + 2] & 0x03) << 4];
            }
            else if (i + 1 < 16)
            {
                result[offset++] = Base64Chars[((num[i] & 0x0F) << 2) | ((num[i + 1] & 0xC0) >> 6)];
                result[offset++] = Base64Chars[num[i + 1] & 0x3F];
            }
            else
            {
                result[offset++] = Base64Chars[(num[i] & 0x0F) << 2];
            }
        }

        return new string(result, 0, 22);
    }

    public static string FromElement(Element element)
    {
        // element.UniqueId is "{GUID}-{suffix}" — extract the GUID part
        string uniqueId = element.UniqueId;
        // The GUID is typically the first 36 characters (with dashes)
        // but Revit UniqueIds can be more complex. Parse the episode GUID:
        if (Guid.TryParse(uniqueId.Substring(0, Math.Min(36, uniqueId.Length)), out var guid))
            return ToIfcGlobalId(guid);

        // Fallback: hash the UniqueId
        using (var md5 = System.Security.Cryptography.MD5.Create())
        {
            var hash = md5.ComputeHash(System.Text.Encoding.UTF8.GetBytes(uniqueId));
            return ToIfcGlobalId(new Guid(hash));
        }
    }
}
```

### Revit Category → IFC Type Mapping

```csharp
private static readonly Dictionary<string, string> CategoryToIfcType =
    new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
{
    {"Walls",                    "IfcWall"},
    {"Floors",                   "IfcSlab"},
    {"Roofs",                    "IfcRoof"},
    {"Ceilings",                 "IfcCovering"},
    {"Doors",                    "IfcDoor"},
    {"Windows",                  "IfcWindow"},
    {"Columns",                  "IfcColumn"},
    {"Structural Columns",       "IfcColumn"},
    {"Structural Framing",       "IfcBeam"},
    {"Structural Foundations",   "IfcFooting"},
    {"Stairs",                   "IfcStair"},
    {"Railings",                 "IfcRailing"},
    {"Ramps",                    "IfcRamp"},
    {"Curtain Panels",           "IfcPlate"},
    {"Curtain Wall Mullions",    "IfcMember"},
    {"Generic Models",           "IfcBuildingElementProxy"},
    {"Ducts",                    "IfcDuctSegment"},
    {"Pipes",                    "IfcPipeSegment"},
    {"Flex Ducts",               "IfcDuctSegment"},
    {"Flex Pipes",               "IfcPipeSegment"},
    {"Duct Fittings",            "IfcDuctFitting"},
    {"Pipe Fittings",            "IfcPipeFitting"},
    {"Duct Accessories",         "IfcDuctFitting"},
    {"Pipe Accessories",         "IfcPipeFitting"},
    {"Mechanical Equipment",     "IfcFlowTerminal"},
    {"Plumbing Fixtures",        "IfcSanitaryTerminal"},
    {"Electrical Equipment",     "IfcElectricDistributionBoard"},
    {"Electrical Fixtures",      "IfcElectricDistributionBoard"},
    {"Cable Trays",              "IfcCableCarrierSegment"},
    {"Conduits",                 "IfcCableSegment"},
    {"Lighting Fixtures",        "IfcLightFixture"},
    {"Fire Alarm Devices",       "IfcAlarm"},
    {"Sprinklers",               "IfcFireSuppressionTerminal"},
    {"Furniture",                "IfcFurnishingElement"},
    {"Furniture Systems",        "IfcFurnishingElement"},
};

public static string GetIfcType(Element element)
{
    var catName = element.Category?.Name;
    if (catName != null && CategoryToIfcType.TryGetValue(catName, out var ifcType))
        return ifcType;
    return "IfcBuildingElementProxy";
}
```

### Full Property Extraction

```csharp
public static ElementData ExtractProperties(Element element, Document doc)
{
    var data = new ElementData();

    data.GlobalId = GlobalIdEncoder.FromElement(element);
    data.ExpressId = element.Id.IntegerValue;
    data.RevitId = element.Id.IntegerValue;
    data.Name = element.Name ?? "";
    data.Category = GetIfcType(element);

    // Level
    if (element.LevelId != ElementId.InvalidElementId)
    {
        var level = doc.GetElement(element.LevelId) as Level;
        data.Level = level?.Name ?? "";
    }

    // Type name
    var typeId = element.GetTypeId();
    if (typeId != ElementId.InvalidElementId)
    {
        var type = doc.GetElement(typeId);
        data.Type = type?.Name ?? "";
    }

    // Materials
    var materialIds = element.GetMaterialIds(false);
    data.Materials = materialIds
        .Select(id => doc.GetElement(id))
        .Where(m => m != null)
        .Select(m => m.Name)
        .Distinct()
        .ToList();

    // Parameters — grouped by ParameterGroup
    data.Parameters = new Dictionary<string, Dictionary<string, object>>();
    foreach (Parameter param in element.Parameters)
    {
        if (!param.HasValue) continue;
        string groupName = LabelUtils.GetLabelFor(param.Definition.ParameterGroup);
        if (string.IsNullOrEmpty(groupName)) groupName = "Other";

        if (!data.Parameters.ContainsKey(groupName))
            data.Parameters[groupName] = new Dictionary<string, object>();

        object value = null;
        switch (param.StorageType)
        {
            case StorageType.String:
                value = param.AsString();
                break;
            case StorageType.Integer:
                value = param.AsInteger();
                break;
            case StorageType.Double:
                // Convert internal units to display units
                value = Math.Round(UnitUtils.ConvertFromInternalUnits(
                    param.AsDouble(), param.GetUnitTypeId()), 4);
                break;
            case StorageType.ElementId:
                var refElem = doc.GetElement(param.AsElementId());
                value = refElem?.Name;
                break;
        }

        if (value != null)
            data.Parameters[param.Definition.Name] = new Dictionary<string, object>
            {
                [param.Definition.Name] = value
            };
        // Simplified: just add to the group dict directly
        data.Parameters[groupName][param.Definition.Name] = value;
    }

    return data;
}
```

---

## Host Relationships (Clash Suppression)

ClashControl suppresses clashes between host elements and their children (e.g., a wall and its door). Extract these relationships:

```csharp
public static class RelationshipExporter
{
    public static (Dictionary<string, string> hostIds,
                   Dictionary<string, List<string>> hostRelationships,
                   Dictionary<string, bool> relatedPairs)
    BuildRelationships(IList<Element> elements, Document doc)
    {
        var hostIds = new Dictionary<string, string>();           // childGid → hostGid
        var hostRelationships = new Dictionary<string, List<string>>(); // hostGid → [childGids]
        var relatedPairs = new Dictionary<string, bool>();

        // Build GlobalId lookup by ElementId
        var eidToGid = new Dictionary<int, string>();
        foreach (var el in elements)
            eidToGid[el.Id.IntegerValue] = GlobalIdEncoder.FromElement(el);

        foreach (var element in elements)
        {
            if (!(element is FamilyInstance fi)) continue;

            // Get host element (wall, floor, ceiling, etc.)
            var host = fi.Host;
            if (host == null) continue;

            if (!eidToGid.TryGetValue(host.Id.IntegerValue, out var hostGid)) continue;
            var childGid = eidToGid[fi.Id.IntegerValue];

            hostIds[childGid] = hostGid;

            if (!hostRelationships.ContainsKey(hostGid))
                hostRelationships[hostGid] = new List<string>();
            hostRelationships[hostGid].Add(childGid);

            // Add relatedPair (both directions for safety)
            relatedPairs[$"{hostGid}:{childGid}"] = true;
            relatedPairs[$"{childGid}:{hostGid}"] = true;
        }

        return (hostIds, hostRelationships, relatedPairs);
    }
}
```

### ElementData Class

```csharp
public class ElementData
{
    [JsonProperty("globalId")] public string GlobalId { get; set; }
    [JsonProperty("expressId")] public int ExpressId { get; set; }
    [JsonProperty("category")] public string Category { get; set; }
    [JsonProperty("name")] public string Name { get; set; }
    [JsonProperty("level")] public string Level { get; set; }
    [JsonProperty("type")] public string Type { get; set; }
    [JsonProperty("revitId")] public int RevitId { get; set; }
    [JsonProperty("materials")] public List<string> Materials { get; set; }
    [JsonProperty("parameters")] public Dictionary<string, Dictionary<string, object>> Parameters { get; set; }
    [JsonProperty("hostId")] public string HostId { get; set; }
    [JsonProperty("hostRelationships")] public List<string> HostRelationships { get; set; }
    [JsonProperty("geometry")] public ElementGeometry Geometry { get; set; }
}

public class ElementGeometry
{
    [JsonProperty("positions")] public string Positions { get; set; }   // base64 Float32Array
    [JsonProperty("indices")] public string Indices { get; set; }       // base64 Uint32Array
    [JsonProperty("normals")] public string Normals { get; set; }       // base64 Float32Array
    [JsonProperty("color")] public float[] Color { get; set; }          // [r, g, b, a] 0-1
}
```
